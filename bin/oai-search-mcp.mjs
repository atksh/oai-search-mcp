#!/usr/bin/env node
// Start oai-search-mcp with OPENAI_API_KEY taken from the current ~/.zshrc.
// MCP clients run `node <this file>` and keep no key in their config, so a key
// rotated in ~/.zshrc reaches every client on its next server start.
// The server runs in this process; the shell never touches MCP stdio.
//
// Each start appends one JSON line (key fingerprint only, never the key) to
// launcher.log, so GUI clients that hide stderr can still be diagnosed.

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_TIMEOUT_MS, fingerprint, readKeyFromZshrc } from "./zshrc-key.mjs";

const PREFIX = "[oai-search-mcp launcher]";
const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const threshold = LEVELS[process.env.LOG_LEVEL ?? "info"] ?? LEVELS.info;
const MAX_TIMEOUT_MS = 600_000;
const MAX_LOG_BYTES = 1024 * 1024;

function log(level, message) {
  if (LEVELS[level] >= threshold) process.stderr.write(`${PREFIX} ${level}: ${message}\n`);
}

function timeoutFromEnv() {
  const raw = process.env.OAI_SEARCH_ZSHRC_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 100 && value <= MAX_TIMEOUT_MS) return value;
  log("warn", `ignoring OAI_SEARCH_ZSHRC_TIMEOUT_MS=${JSON.stringify(raw)} (want an integer from 100 to ${MAX_TIMEOUT_MS}); using ${DEFAULT_TIMEOUT_MS}`);
  return DEFAULT_TIMEOUT_MS;
}

function logFilePath() {
  const configured = process.env.OAI_SEARCH_LAUNCHER_LOG;
  if (configured === "off") return null;
  if (configured) return configured;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Logs", "oai-search-mcp", "launcher.log");
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "oai-search-mcp", "launcher.log");
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
    try {
      if (statSync(file).size > MAX_LOG_BYTES) renameSync(file, `${file}.1`);
    } catch {
      // No log yet.
    }
    const line = { time: new Date().toISOString(), pid: process.pid, ppid: process.ppid, parent: parentCommand(), ...entry };
    appendFileSync(file, `${JSON.stringify(line)}\n`, { mode: 0o600 });
  } catch (error) {
    log("warn", `could not write ${file}: ${error.message}`);
  }
}

const timeoutMs = timeoutFromEnv();
const result = await readKeyFromZshrc({ timeoutMs });
log("debug", `zsh pid ${result.pid}, ${result.ms} ms, ${result.stderrBytes} bytes on stderr, timeout ${timeoutMs} ms`);

if (result.ok) {
  process.env.OPENAI_API_KEY = result.key;
  if (result.warning) log("warn", result.warning);
  log("info", `OPENAI_API_KEY loaded from ~/.zshrc (sha256:${fingerprint(result.key)}, ${result.ms} ms)`);
  record({ source: "zshrc", sha256: fingerprint(result.key), ms: result.ms, warning: result.warning });
} else {
  const detail = result.stderr?.trim() ? `; zsh stderr: ${result.stderr.trim()}` : "";
  const inherited = process.env.OPENAI_API_KEY;
  if (inherited) {
    // Always shown, whatever LOG_LEVEL says: the server is not using the ~/.zshrc key.
    process.stderr.write(
      `${PREFIX} error: could not read OPENAI_API_KEY from ~/.zshrc (${result.reason}${detail}); ` +
        `falling back to the inherited value (sha256:${fingerprint(inherited)}), which may be stale\n`,
    );
    record({ source: "inherited", sha256: fingerprint(inherited), ms: result.ms, reason: result.reason });
  } else {
    process.stderr.write(
      `${PREFIX} error: could not read OPENAI_API_KEY from ~/.zshrc (${result.reason}${detail}) and none was inherited\n`,
    );
    record({ source: "none", ms: result.ms, reason: result.reason });
    process.exit(1);
  }
}

await import("../build/index.js");
