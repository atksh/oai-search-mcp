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
// - the client's environment is passed through except OPENAI_API_KEY and
//   ZDOTDIR, so a stale key or a foreign ZDOTDIR (for example from a Cursor or
//   VS Code terminal) cannot change the answer, while variables ~/.zshrc may
//   test (TMUX, SSH_AUTH_SOCK, XDG_*) still reach it;
// - a hung ~/.zshrc is killed (whole process group) after a timeout, or when
//   this process receives SIGTERM, SIGINT or SIGHUP during the probe;
// - background jobs started by ~/.zshrc are not waited for, and the stderr
//   pipe they inherit stays open so they never get SIGPIPE.
// Limit: if this process is SIGKILLed during the probe, a hung zsh survives.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";

export const DEFAULT_ZSH = "/bin/zsh";
export const DEFAULT_TIMEOUT_MS = 10_000;
// Keep this below 14: Node 26.13 aborts (SIGABRT) on stdio arrays of 15 or more entries.
export const KEY_FD = 11;
const FALLBACK_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
const DROPPED_VARS = ["OPENAI_API_KEY", "ZDOTDIR"];
// `\builtin` bypasses any alias or function named `print` defined in ~/.zshrc.
// -N terminates the value with NUL, so a multi-line value arrives whole.
const PROBE = `\\builtin print -rN -- "\${OPENAI_API_KEY-}" >&${KEY_FD}`;
// Time allowed for key bytes written just before zsh exits to arrive.
const EXIT_GRACE_MS = 200;
const FORWARDED_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];

/** The client's environment minus what must not influence ~/.zshrc. */
export function shellEnv(parentEnv = process.env, zsh = DEFAULT_ZSH) {
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && !DROPPED_VARS.includes(name)) env[name] = value;
  }
  env.HOME ||= os.homedir();
  env.USER ||= os.userInfo().username;
  env.LOGNAME ||= env.USER;
  env.PATH ||= FALLBACK_PATH;
  env.SHELL = zsh;
  return env;
}

export function fingerprint(key) {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

/** Hide anything token-like before a shell message reaches a log. */
export function redact(text) {
  return text.replace(/[A-Za-z0-9_\-+=]{16,}/g, "[redacted]");
}

export function classify(value) {
  if (value === "") return { ok: false, reason: "OPENAI_API_KEY is not set after ~/.zshrc runs" };
  if (/[\s\x00-\x1f\x7f]/.test(value)) {
    return { ok: false, reason: "OPENAI_API_KEY from ~/.zshrc contains whitespace, a line break or a control character" };
  }
  if (!value.startsWith("sk-")) {
    return { ok: true, key: value, warning: "OPENAI_API_KEY from ~/.zshrc does not start with sk-" };
  }
  return { ok: true, key: value };
}

/**
 * Resolve OPENAI_API_KEY the way a new interactive zsh sees it.
 * Never rejects. Resolves to
 *   { ok: true, key, warning?, ms, pid, stderrBytes } or
 *   { ok: false, reason, stderr?, ms, pid, stderrBytes }.
 */
export function readKeyFromZshrc({
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  zsh = DEFAULT_ZSH,
  handleSignals = true,
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
      const extra = result.ok ? {} : { stderr: redact(stderrTail) };
      resolve({ ...result, ...extra, ms: Date.now() - started, pid: child?.pid, stderrBytes });
    };

    // Install the handlers before spawning: a signal that arrives while no
    // listener exists takes the default action and would orphan the shell.
    if (handleSignals) {
      for (const signal of FORWARDED_SIGNALS) {
        const handler = () => {
          killGroup();
          finish({ ok: false, reason: `interrupted by ${signal}` });
          process.kill(process.pid, signal);
        };
        signalHandlers.set(signal, handler);
        process.on(signal, handler);
      }
    }
    process.on("exit", onProcessExit);

    const stdio = Array.from({ length: KEY_FD + 1 }, () => "ignore");
    stdio[2] = "pipe";
    stdio[KEY_FD] = "pipe";
    try {
      child = spawn(zsh, ["-i", "-c", PROBE], { env: shellEnv(env, zsh), stdio, detached: true });
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
      const end = keyBuffer.indexOf("\0");
      if (end !== -1) finish(classify(keyBuffer.slice(0, end)));
    });
    child.on("exit", (code, signal) => {
      graceTimer = setTimeout(
        () => finish({ ok: false, reason: `zsh exited (${signal ?? `code ${code}`}) before reporting OPENAI_API_KEY` }),
        EXIT_GRACE_MS,
      );
    });
  });
}
