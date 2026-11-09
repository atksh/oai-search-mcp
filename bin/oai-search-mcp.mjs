#!/usr/bin/env node
// Start oai-search-mcp with OPENAI_API_KEY taken from the current ~/.zshrc.
// MCP clients run `node <this file>` and keep no key in their config, so a key
// rotated in ~/.zshrc reaches every client on its next server start. A running
// server re-reads ~/.zshrc through a hook when the API rejects its key (401).
// The server runs in this process; the shell never touches MCP stdio.
//
// stderr gets JSON lines in the server's log format. Each start (and each
// re-read) also appends one JSON line, with a key fingerprint and never the
// key, to launcher.log, so GUI clients that hide stderr can still be diagnosed.

import { execFile, execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LEVELS, logThreshold, parseTimeout, resolveLogPath } from "./launcher-config.mjs";
import { DROPPED_VARS, classify, fingerprint, readKeyFromZshrc, redact } from "./zshrc-key.mjs";

const MAX_LOG_BYTES = 1024 * 1024;
const STDERR_IN_LOG = 300;
// index.ts looks this up to re-read the key after the API answers 401.
const REFRESH_HOOK = Symbol.for("oai-search-mcp.refreshApiKey");
const threshold = logThreshold(process.env.LOG_LEVEL);

/** One JSON line on stderr in the server's log format; errors ignore LOG_LEVEL. */
function log(level, event, fields = {}) {
  if (level !== "error" && LEVELS[level] < threshold) return;
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...fields })}\n`);
}
const warn = (message) => log("warn", "launcher_warning", { message });

const logFile = resolveLogPath({ env: process.env, platform: process.platform, home: os.homedir() }, warn);
let parentName;

function psParentArgs() {
  return ["-o", "comm=", "-p", String(process.ppid)];
}

function parentCommandSync() {
  try {
    return path.basename(execFileSync("ps", psParentArgs(), { encoding: "utf8", timeout: 1000 }).trim()) || undefined;
  } catch {
    return undefined;
  }
}

function appendRecord(line) {
  if (!logFile) return;
  try {
    mkdirSync(path.dirname(logFile), { recursive: true });
    let stat;
    try {
      stat = lstatSync(logFile);
    } catch {
      // No log yet.
    }
    // A FIFO would block, and a device such as /dev/stdout would corrupt MCP stdio.
    if (stat && !stat.isFile()) {
      warn(`not logging to ${logFile}: it is not a regular file`);
      return;
    }
    if (stat && stat.size > MAX_LOG_BYTES) renameSync(logFile, `${logFile}.1`);
    appendFileSync(logFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (error) {
    warn(`could not write ${logFile}: ${error.message}`);
  }
}

function recordLine(entry) {
  return { time: new Date().toISOString(), pid: process.pid, ppid: process.ppid, parent: parentName, ...entry };
}

/** Write a record now; for paths that exit right after. */
function recordNow(entry) {
  parentName ??= parentCommandSync();
  appendRecord(recordLine(entry));
}

/** Write a record without blocking the server on the `ps` lookup. */
function recordLater(entry) {
  const line = recordLine(entry);
  if (parentName !== undefined || !logFile) {
    appendRecord(line);
    return;
  }
  execFile("ps", psParentArgs(), { encoding: "utf8", timeout: 1000 }, (error, stdout) => {
    parentName = error ? undefined : path.basename(stdout.trim()) || undefined;
    appendRecord({ ...line, parent: parentName });
  });
}

const timeoutMs = parseTimeout(process.env.OAI_SEARCH_ZSHRC_TIMEOUT_MS, warn);
const dropped = DROPPED_VARS.filter((name) => process.env[name] !== undefined);
const result = await readKeyFromZshrc({
  timeoutMs,
  onSignal: (signal) => {
    const message = `interrupted by ${signal} while reading ~/.zshrc`;
    log("error", "launcher_error", { message });
    recordNow({ source: "none", reason: message });
  },
});
log("debug", "launcher_probe", {
  zshPid: result.pid,
  ms: result.ms,
  stderrBytes: result.stderrBytes,
  timeoutMs,
  ignoredFromClientEnv: dropped,
});

let entry;
if (result.ok) {
  process.env.OPENAI_API_KEY = result.key;
  Object.assign(process.env, result.settings);
  for (const message of [result.warning, ...result.warnings].filter(Boolean)) warn(message);
  const settings = Object.keys(result.settings);
  const sha256 = fingerprint(result.key);
  log("info", "launcher_key_loaded", { source: "zshrc", sha256, ms: result.ms, settings });
  entry = { source: "zshrc", sha256, ms: result.ms, settings: settings.length ? settings : undefined, warning: result.warning };
} else {
  const shellStderr = result.stderr?.trim() ? result.stderr.trim().slice(-STDERR_IN_LOG) : undefined;
  const why = `could not read OPENAI_API_KEY from ~/.zshrc (${result.reason}${shellStderr ? `; zsh stderr: ${shellStderr}` : ""})`;
  const inheritedRaw = process.env.OPENAI_API_KEY?.trim();
  const inherited = inheritedRaw ? classify(inheritedRaw, "the inherited environment") : undefined;
  if (inherited?.ok) {
    process.env.OPENAI_API_KEY = inherited.key;
    const sha256 = fingerprint(inherited.key);
    log("error", "launcher_key_fallback", {
      message: `${why}; falling back to the inherited value, which may be stale`,
      source: "inherited",
      sha256,
    });
    entry = { source: "inherited", sha256, ms: result.ms, reason: result.reason, stderr: shellStderr };
  } else {
    const inheritedProblem = inherited ? `; ${inherited.reason}` : " and none was inherited";
    log("error", "launcher_error", { message: `${why}${inheritedProblem}` });
    recordNow({ source: "none", ms: result.ms, reason: `${result.reason}${inheritedProblem}`, stderr: shellStderr });
    process.exit(1);
  }
}

// Re-read ~/.zshrc when the server's key is rejected; resolves to null when it cannot.
globalThis[REFRESH_HOOK] = async () => {
  const fresh = await readKeyFromZshrc({ timeoutMs });
  if (!fresh.ok) {
    log("error", "launcher_key_refresh_failed", { reason: fresh.reason });
    recordLater({ event: "refresh", source: "none", ms: fresh.ms, reason: fresh.reason });
    return null;
  }
  process.env.OPENAI_API_KEY = fresh.key;
  Object.assign(process.env, fresh.settings);
  const sha256 = fingerprint(fresh.key);
  log("info", "launcher_key_refreshed", { source: "zshrc", sha256, ms: fresh.ms });
  recordLater({ event: "refresh", source: "zshrc", sha256, ms: fresh.ms });
  return { key: fresh.key, settings: fresh.settings };
};

try {
  await import("../build/index.js");
} catch (error) {
  const message = redact(error?.message ?? String(error));
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  log("error", "launcher_error", { message: `could not load the server (${message}); run \`pnpm build\` in ${repo}` });
  recordNow({ ...entry, serverError: message });
  process.exit(1);
}
recordLater(entry);
