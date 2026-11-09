// Read OPENAI_API_KEY from the user's current ~/.zshrc.
//
// The shell is isolated so nothing in ~/.zshrc can disturb an MCP server:
// - it runs in a new session (setsid), so it has no controlling terminal and
//   cannot take over the terminal of a CLI client such as Claude Code;
// - its stdin is /dev/null and its stdout is discarded, so ~/.zshrc can neither
//   consume JSON-RPC input nor write into the JSON-RPC output;
// - the key comes back NUL-terminated on a dedicated fd (11), so echoes in
//   ~/.zshrc, or ~/.zshrc closing or redirecting fds 3-9, cannot corrupt it
//   (zsh puts its own fds at the lowest free number from 10, so it skips 11);
// - the client's environment is passed through except the OpenAI connection
//   variables and ZDOTDIR, so a stale key or a foreign ZDOTDIR (for example
//   from a Cursor or VS Code terminal) cannot change the answer, while
//   variables ~/.zshrc may test (TMUX, SSH_AUTH_SOCK, XDG_*) still reach it;
// - OPENAI_ORG_ID, OPENAI_PROJECT_ID and OPENAI_BASE_URL are read along with
//   the key, because a key only works with its own organization, project and
//   endpoint;
// - a hung ~/.zshrc is killed (whole process group) after a timeout, or when
//   this process receives SIGTERM, SIGINT or SIGHUP during the probe;
// - background jobs started by ~/.zshrc are not waited for, and the stderr
//   pipe they inherit stays drained while this process lives, so they do not
//   get SIGPIPE while the server runs;
// - a probe shell still running 1 s after reporting (a slow EXIT trap or
//   zshexit hook) is killed, without touching its background jobs.
// Limits: if this process is SIGKILLed during the probe, a hung zsh survives;
// a function named `builtin` in ~/.zshrc defeats the probe.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";

const DEFAULT_ZSH = "/bin/zsh";
export const DEFAULT_TIMEOUT_MS = 10_000;
// Keep this below 14: Node 26.13 aborts (SIGABRT) on stdio arrays of 15 or more entries.
const KEY_FD = 11;
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
/** Settings that belong to the key and are taken from ~/.zshrc with it. */
export const COMPANION_VARS = ["OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_BASE_URL"];
const PROBED_VARS = ["OPENAI_API_KEY", ...COMPANION_VARS];
export const DROPPED_VARS = [...PROBED_VARS, "ZDOTDIR"];
// `\builtin` bypasses any alias or function named `print`, and quoting
// `\print` also defeats a global alias (`alias -g print=...`).
// -N terminates each value with NUL, so a multi-line value arrives whole.
const PROBE = `\\builtin \\print -rN -- ${PROBED_VARS.map((name) => `"\${${name}-}"`).join(" ")} >&${KEY_FD}`;
// Time allowed for key bytes written just before zsh exits to arrive.
const EXIT_GRACE_MS = 200;
// How long a probe shell may keep running after it reported the key.
const REAP_AFTER_MS = 1000;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

/** The client's environment minus what must not influence ~/.zshrc. */
export function shellEnv(parentEnv = process.env, zsh = DEFAULT_ZSH) {
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && !DROPPED_VARS.includes(name)) env[name] = value;
  }
  try {
    env.HOME ||= os.homedir();
  } catch {
    // No passwd entry: zsh falls back to its own default.
  }
  try {
    env.USER ||= os.userInfo().username;
  } catch {
    // No passwd entry for this uid.
  }
  if (env.USER) env.LOGNAME ||= env.USER;
  env.PATH ||= FALLBACK_PATH;
  env.SHELL = zsh;
  return env;
}

export function fingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/**
 * Hide secret-looking strings before a shell message reaches a log, while
 * keeping ordinary command, file and plugin names readable.
 */
export function redact(text) {
  return text.replace(/sk-[A-Za-z0-9_-]+/g, "sk-[redacted]").replace(/[A-Za-z0-9_\-+=]{32,}/g, "[redacted]");
}

export function classify(value, source = "~/.zshrc") {
  if (value === "") return { ok: false, reason: `OPENAI_API_KEY is not set after ${source} runs` };
  if (/[\s\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, reason: `OPENAI_API_KEY from ${source} contains whitespace, a line break or a control character` };
  }
  if (!value.startsWith("sk-")) {
    return { ok: true, key: value, warning: `OPENAI_API_KEY from ${source} does not start with sk-` };
  }
  return { ok: true, key: value };
}

/** Keep the companion settings ~/.zshrc defines; an unusable one is dropped with a warning. */
function companionSettings(values) {
  const settings = {};
  const warnings = [];
  COMPANION_VARS.forEach((name, index) => {
    const value = values[index] ?? "";
    if (value === "") return;
    if (/[\s\x00-\x1f\x7f]/.test(value)) {
      warnings.push(`ignoring ${name} from ~/.zshrc: it contains whitespace or a control character`);
    } else if (name === "OPENAI_BASE_URL" && !/^https?:\/\/[^/]/.test(value)) {
      warnings.push(`ignoring ${name} from ~/.zshrc: it is not an http(s) URL`);
    } else {
      settings[name] = value;
    }
  });
  return { settings, warnings };
}

/**
 * Resolve OPENAI_API_KEY (and its companion settings) the way a new
 * interactive zsh sees them. Never rejects. Resolves to
 *   { ok: true, key, settings, warning?, warnings, ms, pid, stderrBytes } or
 *   { ok: false, reason, stderr?, ms, pid, stderrBytes }.
 */
export function readKeyFromZshrc({
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  zsh = DEFAULT_ZSH,
  // Called synchronously when SIGTERM, SIGINT or SIGHUP interrupts the probe,
  // before the signal is re-raised, so the caller can still log.
  onSignal,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    let keyBuffer = "";
    let stderrTail = "";
    let stderrBytes = 0;
    let child;
    let timeoutTimer;
    let graceTimer;
    const signalHandlers = new Map();

    const killGroup = () => {
      try {
        if (child?.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group is already gone.
      }
    };
    const onProcessExit = () => killGroup();

    // Kill only the shell itself (not its background jobs) if it outlives its report.
    const reapProbeShell = () => {
      if (!child?.pid) return;
      const running = () => child.exitCode === null && child.signalCode === null;
      if (!running()) return;
      const killShell = () => {
        if (!running()) return;
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      };
      const timer = setTimeout(killShell, REAP_AFTER_MS);
      timer.unref();
      process.once("exit", killShell);
      child.once("exit", () => {
        clearTimeout(timer);
        process.off("exit", killShell);
      });
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(graceTimer);
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
      process.off("exit", onProcessExit);
      child?.stdio?.[KEY_FD]?.destroy();
      // Keep draining stderr so ~/.zshrc background jobs that log there never get SIGPIPE.
      child?.stderr?.removeAllListeners("data");
      child?.stderr?.on("data", () => {});
      child?.stderr?.unref?.();
      child?.unref();
      reapProbeShell();
      const extra = result.ok ? {} : { stderr: redact(stderrTail) };
      resolve({ ...result, ...extra, ms: Date.now() - started, pid: child?.pid, stderrBytes });
    };

    // Install the handlers before spawning: a signal that arrives while no
    // listener exists takes the default action and would orphan the shell.
    for (const signal of FORWARDED_SIGNALS) {
      const handler = () => {
        killGroup();
        finish({ ok: false, reason: `interrupted by ${signal}` });
        try {
          onSignal?.(signal);
        } catch {
          // Logging must not keep the process alive.
        }
        // Re-raise for the default action, unless the host handles this signal itself.
        if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    process.on("exit", onProcessExit);

    const stdio = Array.from({ length: KEY_FD + 1 }, () => "ignore");
    stdio[2] = "pipe";
    stdio[KEY_FD] = "pipe";
    const childEnv = shellEnv(env, zsh);
    try {
      child = spawn(zsh, ["-i", "-c", PROBE], { env: childEnv, stdio, detached: true });
    } catch (error) {
      finish({ ok: false, reason: `could not start ${zsh}: ${error.message}` });
      return;
    }

    timeoutTimer = setTimeout(() => {
      killGroup();
      finish({ ok: false, reason: `~/.zshrc did not finish within ${timeoutMs} ms` });
    }, timeoutMs);

    child.on("error", (error) => finish({ ok: false, reason: `could not start ${zsh}: ${error.message}` }));
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      stderrTail = (stderrTail + chunk).slice(-1000);
    });
    child.stdio[KEY_FD]?.setEncoding("utf8").on("data", (chunk) => {
      keyBuffer += chunk;
      const values = keyBuffer.split("\0");
      // Every value is NUL-terminated, so all have arrived once there are more parts than values.
      if (values.length <= PROBED_VARS.length) return;
      const result = classify(values[0]);
      if (!result.ok) {
        finish(result);
        return;
      }
      const { settings, warnings } = companionSettings(values.slice(1));
      finish({ ...result, settings, warnings });
    });
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(
        () => finish({ ok: false, reason: `zsh exited (${signal ?? `code ${code}`}) before reporting OPENAI_API_KEY` }),
        EXIT_GRACE_MS,
      );
    });
  });
}
