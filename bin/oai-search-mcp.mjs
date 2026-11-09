#!/usr/bin/env node
// Start oai-search-mcp with OPENAI_API_KEY taken from the current ~/.zshrc.
// MCP clients run `node <this file>` and keep no key in their config, so a key
// rotated in ~/.zshrc reaches every client on its next server start.
// The server runs in this process; the shell never touches MCP stdio.
//
// Each start appends one JSON line (key fingerprint only, never the key) to
// launcher.log, so GUI clients that hide stderr can still be diagnosed.

import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_TIMEOUT_MS, classify, fingerprint, readKeyFromZshrc, redact } from "./zshrc-key.mjs";

const PREFIX = "[oai-search-mcp launcher]";
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const levelName = (process.env.LOG_LEVEL ?? "info").trim().toLowerCase();
const threshold = Object.hasOwn(LEVELS, levelName) ? LEVELS[levelName] : LEVELS.info;
// The probe delays the MCP initialize reply; stay under client startup budgets (Codex about 30 s).
const MAX_TIMEOUT_MS = 25_000;
const MAX_LOG_BYTES = 1024 * 1024;
const STDERR_IN_LOG = 300;

function log(level, message) {
  if (LEVELS[level] >= threshold) process.stderr.write(`${PREFIX} ${level}: ${message}\n`);
}

/** Errors are shown whatever LOG_LEVEL says. */
function fail(message) {
  process.stderr.write(`${PREFIX} error: ${message}\n`);
}

function timeoutFromEnv() {
  const raw = process.env.OAI_SEARCH_ZSHRC_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 100 && value <= MAX_TIMEOUT_MS) return value;
  log("warn", `ignoring OAI_SEARCH_ZSHRC_TIMEOUT_MS=${JSON.stringify(raw)} (want an integer from 100 to ${MAX_TIMEOUT_MS}); using ${DEFAULT_TIMEOUT_MS}`);
  return DEFAULT_TIMEOUT_MS;
}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function defaultLogPath() {
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Logs", "oai-search-mcp", "launcher.log");
  const stateHome = process.env.XDG_STATE_HOME;
  const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(os.homedir(), ".local", "state");
  return path.join(base, "oai-search-mcp", "launcher.log");
}

function logFilePath() {
  const configured = process.env.OAI_SEARCH_LAUNCHER_LOG;
  if (configured === "off") return null;
  if (!configured) return defaultLogPath();
  const expanded = expandHome(configured);
  if (path.isAbsolute(expanded)) return expanded;
  log("warn", `ignoring OAI_SEARCH_LAUNCHER_LOG=${JSON.stringify(configured)} (want an absolute path or "off")`);
  return defaultLogPath();
}

function parentCommand() {
  const ps = spawnSync("ps", ["-o", "comm=", "-p", String(process.ppid)], { encoding: "utf8", timeout: 1000 });
  return ps.status === 0 ? path.basename(ps.stdout.trim()) : undefined;
}

/** Append one record to launcher.log; logging must never stop the server from starting. */
function record(entry) {
  const file = logFilePath();
  if (!file) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    let stat;
    try {
      stat = lstatSync(file);
    } catch {
      // No log yet.
    }
    // A FIFO would block, and a device such as /dev/stdout would corrupt MCP stdio.
    if (stat && !stat.isFile()) {
      log("warn", `not logging to ${file}: it is not a regular file`);
      return;
    }
    if (stat && stat.size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    const line = { time: new Date().toISOString(), pid: process.pid, ppid: process.ppid, parent: parentCommand(), ...entry };
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (error) {
    log("warn", `could not write ${file}: ${error.message}`);
  }
}

const timeoutMs = timeoutFromEnv();
const result = await readKeyFromZshrc({
  timeoutMs,
  onSignal: (signal) => {
    fail(`interrupted by ${signal} while reading ~/.zshrc`);
    record({ source: "none", reason: `interrupted by ${signal} while reading ~/.zshrc` });
  },
});
log("debug", `zsh pid ${result.pid}, ${result.ms} ms, ${result.stderrBytes} bytes on stderr, timeout ${timeoutMs} ms`);

let entry;
if (result.ok) {
  process.env.OPENAI_API_KEY = result.key;
  if (result.warning) log("warn", result.warning);
  log("info", `OPENAI_API_KEY loaded from ~/.zshrc (sha256:${fingerprint(result.key)}, ${result.ms} ms)`);
  entry = { source: "zshrc", sha256: fingerprint(result.key), ms: result.ms, warning: result.warning };
} else {
  const shellStderr = result.stderr?.trim() ? result.stderr.trim().slice(-STDERR_IN_LOG) : undefined;
  const why = `could not read OPENAI_API_KEY from ~/.zshrc (${result.reason}${shellStderr ? `; zsh stderr: ${shellStderr}` : ""})`;
  const inheritedRaw = process.env.OPENAI_API_KEY?.trim();
  const inherited = inheritedRaw ? classify(inheritedRaw, "the inherited environment") : undefined;
  if (inherited?.ok) {
    process.env.OPENAI_API_KEY = inherited.key;
    fail(`${why}; falling back to the inherited value (sha256:${fingerprint(inherited.key)}), which may be stale`);
    entry = { source: "inherited", sha256: fingerprint(inherited.key), ms: result.ms, reason: result.reason, stderr: shellStderr };
  } else {
    const inheritedProblem = inherited ? `; ${inherited.reason}` : " and none was inherited";
    fail(`${why}${inheritedProblem}`);
    record({ source: "none", ms: result.ms, reason: `${result.reason}${inheritedProblem}`, stderr: shellStderr });
    process.exit(1);
  }
}

try {
  await import("../build/index.js");
} catch (error) {
  const message = redact(error?.message ?? String(error));
  const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  fail(`could not load the server (${message}); run \`pnpm build\` in ${repo}`);
  record({ ...entry, serverError: message });
  process.exit(1);
}
record(entry);
