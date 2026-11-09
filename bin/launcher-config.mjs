// Pure configuration helpers for bin/oai-search-mcp.mjs, kept apart so they
// can be tested without starting a server.

import path from "node:path";

import { DEFAULT_TIMEOUT_MS } from "./zshrc-key.mjs";

export const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
// The probe delays the MCP initialize reply; stay under client startup budgets (Codex about 30 s).
export const MAX_TIMEOUT_MS = 25_000;
const MIN_TIMEOUT_MS = 100;

/** Numeric threshold for LOG_LEVEL; unknown names (including Object.prototype members) mean info. */
export function logThreshold(raw) {
  const name = (raw ?? "info").trim().toLowerCase();
  return Object.hasOwn(LEVELS, name) ? LEVELS[name] : LEVELS.info;
}

/** OAI_SEARCH_ZSHRC_TIMEOUT_MS as milliseconds; calls warn and returns the default when invalid. */
export function parseTimeout(raw, warn = () => {}) {
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS) return value;
  warn(
    `ignoring OAI_SEARCH_ZSHRC_TIMEOUT_MS=${JSON.stringify(raw)} ` +
      `(want an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}); using ${DEFAULT_TIMEOUT_MS}`,
  );
  return DEFAULT_TIMEOUT_MS;
}

export function expandHome(value, home) {
  return value === "~" || value.startsWith("~/") ? path.join(home, value.slice(1)) : value;
}

/** launcher.log location, or null when OAI_SEARCH_LAUNCHER_LOG is "off". */
export function resolveLogPath({ env, platform, home }, warn = () => {}) {
  const fallback = () => {
    if (platform === "darwin") return path.join(home, "Library", "Logs", "oai-search-mcp", "launcher.log");
    const stateHome = env.XDG_STATE_HOME;
    const base = stateHome && path.isAbsolute(stateHome) ? stateHome : path.join(home, ".local", "state");
    return path.join(base, "oai-search-mcp", "launcher.log");
  };
  const configured = env.OAI_SEARCH_LAUNCHER_LOG;
  if (configured === "off") return null;
  if (!configured) return fallback();
  const expanded = expandHome(configured, home);
  if (path.isAbsolute(expanded)) return expanded;
  warn(`ignoring OAI_SEARCH_LAUNCHER_LOG=${JSON.stringify(configured)} (want an absolute path or "off")`);
  return fallback();
}
