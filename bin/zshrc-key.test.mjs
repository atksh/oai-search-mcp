import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { LEVELS, MAX_TIMEOUT_MS, logThreshold, parseTimeout, resolveLogPath } from "./launcher-config.mjs";
import { DEFAULT_TIMEOUT_MS, classify, fingerprint, readKeyFromZshrc, redact, shellEnv } from "./zshrc-key.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "oai-search-mcp.mjs");
const moduleUrl = new URL("./zshrc-key.mjs", import.meta.url).href;
const builtServer = path.join(here, "..", "build", "index.js");
const hasZsh = existsSync("/bin/zsh");
// A ~/.zshrc that records its shell pid and then hangs.
const HANGING_RC = "print $$ > $HOME/zsh.pid\nsleep 30\n";
const homes = [];

function fakeHome(zshrc) {
  const home = mkdtempSync(path.join(os.tmpdir(), "oai-zshrc-"));
  writeFileSync(path.join(home, ".zshrc"), zshrc);
  homes.push(home);
  return home;
}

/** The developer's environment for a fake home, without anything that would redirect zsh to a real config. */
function isolatedEnv(home) {
  const env = { ...process.env, HOME: home };
  delete env.ZDOTDIR;
  delete env.OPENAI_API_KEY;
  return env;
}

function envFor(home, extra = {}) {
  return { HOME: home, PATH: process.env.PATH, USER: process.env.USER, ...extra };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True once pid is gone or a zombie; kill(pid, 0) alone still succeeds for an unreaped zombie. */
async function waitDead(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!pidAlive(pid)) return true;
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    if (stat === "" || stat.startsWith("Z")) return true;
    if (Date.now() > deadline) return false;
    await sleep(25);
  }
}

async function waitForFile(file, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(file) || readFileSync(file, "utf8").trim() === "") {
    if (Date.now() > deadline) throw new Error(`${file} never appeared`);
    await sleep(25);
  }
  return readFileSync(file, "utf8").trim();
}

after(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("shellEnv", () => {
  test("passes the client environment through except OPENAI_API_KEY and ZDOTDIR", () => {
    const env = shellEnv(
      { HOME: "/h", PATH: "/p", USER: "u", TMUX: "t", SSH_AUTH_SOCK: "s", OPENAI_API_KEY: "sk-x", OPENAI_ORG_ID: "o", OPENAI_BASE_URL: "b", ZDOTDIR: "/z" },
      "/bin/zsh",
    );
    assert.equal(env.TMUX, "t");
    assert.equal(env.SSH_AUTH_SOCK, "s");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ZDOTDIR, undefined);
    assert.equal(env.OPENAI_ORG_ID, undefined);
    assert.equal(env.OPENAI_BASE_URL, undefined);
    assert.equal(env.SHELL, "/bin/zsh");
  });

  test("fills HOME, USER, LOGNAME and PATH when the client gives none", () => {
    const env = shellEnv({ HOME: "", PATH: "" });
    assert.equal(env.HOME, os.homedir());
    assert.equal(env.USER, os.userInfo().username);
    assert.equal(env.LOGNAME, env.USER);
    assert.equal(env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
  });
});

describe("classify and redact", () => {
  test("accepts an sk- key and warns about other formats", () => {
    assert.deepEqual(classify("sk-abc"), { ok: true, key: "sk-abc" });
    assert.match(classify("hello").warning, /does not start with sk-/);
  });

  test("rejects line breaks, carriage returns and spaces", () => {
    for (const bad of ["sk-a\nb", "sk-a\r", "sk-a b"]) assert.equal(classify(bad).ok, false, JSON.stringify(bad));
  });

  test("redact hides sk- tokens and 32+ character runs but keeps diagnostics readable", () => {
    assert.equal(redact("x sk-abc123 y"), "x sk-[redacted] y");
    assert.equal(redact(`token ${"a1".repeat(16)}`), "token [redacted]");
    const diagnostic = "/Users/me/.oh-my-zsh/plugins/zsh-autosuggestions/x.zsh:12: command not found: some_very_long_helper_name";
    assert.equal(redact(diagnostic), diagnostic);
  });
});

describe("readKeyFromZshrc", { skip: !hasZsh && "zsh is not installed" }, () => {
  test("returns the key exported by ~/.zshrc", async () => {
    const result = await readKeyFromZshrc({ env: envFor(fakeHome("export OPENAI_API_KEY=sk-test-plain\n")) });
    assert.equal(result.ok, true);
    assert.equal(result.key, "sk-test-plain");
    assert.equal(typeof result.pid, "number");
  });

  test("ignores stdout and stderr noise and stdin reads in ~/.zshrc", async () => {
    const home = fakeHome(
      ["echo NOISE", "print -u2 ERR", "read -t 1 line", "cat", "export OPENAI_API_KEY=sk-test-noisy"].join("\n"),
    );
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-noisy");
    assert.ok(result.stderrBytes > 0);
  });

  test("survives ~/.zshrc closing fds 3 to 9 and allocating {fd}s", async () => {
    const home = fakeHome(
      "exec 3>&-\nexec 4>/dev/null\nexec 9>&-\nexec {a}>/dev/null\nexec {b}>/dev/null\nexport OPENAI_API_KEY=sk-test-fds\n",
    );
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-fds");
  });

  test("ignores a print alias or function defined in ~/.zshrc", async () => {
    const home = fakeHome(
      ["print() { echo hijacked }", "alias print='echo hijacked'", "export OPENAI_API_KEY=sk-test-alias"].join("\n"),
    );
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-alias");
  });

  test("ignores a global alias for print defined in ~/.zshrc", async () => {
    const home = fakeHome("alias -g print='echo hijacked'\nexport OPENAI_API_KEY=sk-test-global-alias\n");
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-global-alias");
  });

  test("kills a probe shell whose EXIT trap keeps it running, but not its background jobs", async () => {
    const home = fakeHome(
      "export OPENAI_API_KEY=sk-test-trap\n(sleep 3; print alive > $HOME/bg.txt) &!\ntrap 'sleep 30' EXIT\n",
    );
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-trap");
    assert.ok(await waitDead(result.pid, 3000), "the probe zsh is still running");
    assert.equal(await waitForFile(path.join(home, "bg.txt"), 6000), "alive");
  });

  test("ignores a stale inherited key, even with a conditional assignment", async () => {
    const home = fakeHome(": ${OPENAI_API_KEY:=sk-test-from-zshrc}\nexport OPENAI_API_KEY\n");
    const result = await readKeyFromZshrc({ env: envFor(home, { OPENAI_API_KEY: "sk-test-stale" }) });
    assert.equal(result.key, "sk-test-from-zshrc");
  });

  test("ignores an inherited ZDOTDIR and reads ~/.zshrc", async () => {
    const home = fakeHome("export OPENAI_API_KEY=sk-test-home\n");
    const other = fakeHome("export OPENAI_API_KEY=sk-test-foreign-zdotdir\n");
    const result = await readKeyFromZshrc({ env: envFor(home, { ZDOTDIR: other }) });
    assert.equal(result.key, "sk-test-home");
  });

  test("reads OPENAI_ORG_ID, OPENAI_PROJECT_ID and OPENAI_BASE_URL with the key, ignoring the client's", async () => {
    const home = fakeHome(
      "export OPENAI_API_KEY=sk-test-c\nexport OPENAI_ORG_ID=org-z\nexport OPENAI_BASE_URL=https://proxy.example/v1\n",
    );
    const result = await readKeyFromZshrc({
      env: envFor(home, { OPENAI_ORG_ID: "org-stale", OPENAI_PROJECT_ID: "proj_stale" }),
    });
    assert.equal(result.key, "sk-test-c");
    assert.deepEqual(result.settings, { OPENAI_ORG_ID: "org-z", OPENAI_BASE_URL: "https://proxy.example/v1" });
    assert.deepEqual(result.warnings, []);
  });

  test("drops an unusable OpenAI setting from ~/.zshrc with a warning", async () => {
    const home = fakeHome("export OPENAI_API_KEY=sk-test-c\nexport OPENAI_BASE_URL=proxy.example\nexport OPENAI_PROJECT_ID='proj a'\n");
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-c");
    assert.deepEqual(result.settings, {});
    assert.equal(result.warnings.length, 2);
  });

  test("passes client variables such as TMUX through to ~/.zshrc", async () => {
    const home = fakeHome('[[ -z $TMUX ]] && exit 9\nexport OPENAI_API_KEY=sk-test-tmux\n');
    const result = await readKeyFromZshrc({ env: envFor(home, { TMUX: "/tmp/tmux-1/default,1,0" }) });
    assert.equal(result.key, "sk-test-tmux");
  });

  test("rejects a multi-line key instead of keeping its first line", async () => {
    const home = fakeHome("export OPENAI_API_KEY=$'sk-test-line1\\nline2'\n");
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /line break/);
  });

  test("reports a key that ~/.zshrc does not set", async () => {
    const result = await readKeyFromZshrc({ env: envFor(fakeHome("# nothing\n")) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not set/);
  });

  test("reports a ~/.zshrc that exits before the key is read, with its stderr", async () => {
    const result = await readKeyFromZshrc({ env: envFor(fakeHome("print -u2 broken-rc\nexit 3\n")) });
    assert.equal(result.ok, false);
    assert.match(result.reason, /exited \(code 3\)/);
    assert.match(result.stderr, /broken-rc/);
  });

  test("reports a missing zsh binary", async () => {
    const result = await readKeyFromZshrc({ env: envFor(fakeHome("")), zsh: "/nonexistent/zsh" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /could not start/);
  });

  test("times out on a hung ~/.zshrc and kills the shell", async () => {
    const home = fakeHome("print $$ > $HOME/zsh.pid\nsleep 30\nexport OPENAI_API_KEY=sk-test-late\n");
    const result = await readKeyFromZshrc({ env: envFor(home), timeoutMs: 1000 });
    assert.equal(result.ok, false);
    assert.match(result.reason, /did not finish within 1000 ms/);
    assert.ok(result.ms < 3000, `took ${result.ms} ms`);
    const pid = Number(await waitForFile(path.join(home, "zsh.pid")));
    assert.ok(await waitDead(pid), "the hung zsh is still running");
  });

  test("kills the shell and still dies by the signal when SIGTERM arrives during the probe", async () => {
    const home = fakeHome(HANGING_RC);
    const code = `import {readKeyFromZshrc} from ${JSON.stringify(moduleUrl)}; await readKeyFromZshrc({timeoutMs: 60000});`;
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: isolatedEnv(home),
      stdio: "ignore",
    });
    const zshPid = Number(await waitForFile(path.join(home, "zsh.pid")));
    wrapper.kill("SIGTERM");
    const [exitCode, signal] = await new Promise((r) => wrapper.on("exit", (c, s) => r([c, s])));
    assert.equal(signal, "SIGTERM", `wrapper exited with code ${exitCode}`);
    assert.ok(await waitDead(zshPid), "the probe zsh outlived its parent");
  });

  test("does not re-raise a signal that the host process handles itself", async () => {
    const home = fakeHome(HANGING_RC);
    const code = [
      `import {readKeyFromZshrc} from ${JSON.stringify(moduleUrl)};`,
      "let calls = 0;",
      "process.on('SIGTERM', () => { calls++; setTimeout(() => { console.log('calls=' + calls); process.exit(0); }, 300); });",
      "await readKeyFromZshrc({timeoutMs: 60000});",
    ].join("\n");
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: isolatedEnv(home),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    wrapper.stdout.on("data", (chunk) => (out += chunk));
    const zshPid = Number(await waitForFile(path.join(home, "zsh.pid")));
    wrapper.kill("SIGTERM");
    const [exitCode, signal] = await new Promise((r) => wrapper.on("exit", (c, s) => r([c, s])));
    assert.equal(signal, null);
    assert.equal(exitCode, 0);
    assert.equal(out.trim(), "calls=1");
    assert.ok(await waitDead(zshPid), "the probe zsh outlived the interruption");
  });

  test("does not wait for background jobs that keep the key pipe open", async () => {
    const home = fakeHome("export OPENAI_API_KEY=sk-test-bg\n(sleep 30) &!\nprint $! > $HOME/bg.pid\n");
    const result = await readKeyFromZshrc({ env: envFor(home), timeoutMs: 5000 });
    const bg = Number(await waitForFile(path.join(home, "bg.pid")));
    if (pidAlive(bg)) process.kill(bg);
    assert.equal(result.key, "sk-test-bg");
    assert.ok(result.ms < 3000, `took ${result.ms} ms`);
  });

  test("leaves background jobs that log to stderr alive after the probe", async () => {
    const home = fakeHome(
      "export OPENAI_API_KEY=sk-test-daemon\n( sleep 0.5; print -u2 late; sleep 0.3; print alive > $HOME/daemon.txt ) &!\n",
    );
    const result = await readKeyFromZshrc({ env: envFor(home) });
    assert.equal(result.key, "sk-test-daemon");
    assert.equal(await waitForFile(path.join(home, "daemon.txt")), "alive");
  });

  test(
    "gives ~/.zshrc no controlling terminal even when the client has one",
    { skip: process.platform !== "darwin" && "uses the macOS script(1) syntax" },
    () => {
      const probe = "if { : > /dev/tty } 2>/dev/null; then r=tty; else r=notty; fi\nprint $r > $HOME/tty.txt\n";
      const runUnderPty = (home, code) =>
        spawnSync("script", ["-q", "/dev/null", process.execPath, "--input-type=module", "-e", code], {
          env: isolatedEnv(home),
          stdio: "ignore",
          timeout: 30_000,
        });
      // Control: a plain interactive zsh in the client's session can open the terminal.
      const control = fakeHome(probe);
      runUnderPty(control, `import {spawnSync} from "node:child_process"; spawnSync("/bin/zsh", ["-i", "-c", "true"], {stdio: "ignore"});`);
      assert.equal(readFileSync(path.join(control, "tty.txt"), "utf8").trim(), "tty", "the pty harness gave no terminal");

      const isolated = fakeHome(probe);
      runUnderPty(isolated, `import {readKeyFromZshrc} from ${JSON.stringify(moduleUrl)}; await readKeyFromZshrc();`);
      assert.equal(readFileSync(path.join(isolated, "tty.txt"), "utf8").trim(), "notty");
    },
  );
});

describe("launcher configuration", () => {
  test("logThreshold maps names case-insensitively and treats unknown names as info", () => {
    assert.equal(logThreshold("WARN"), LEVELS.warn);
    assert.equal(logThreshold(undefined), LEVELS.info);
    for (const odd of ["constructor", "toString", "__proto__", "verbose"]) assert.equal(logThreshold(odd), LEVELS.info, odd);
  });

  test("parseTimeout accepts 100 to 25000 ms and warns about anything else", () => {
    const warnings = [];
    const warn = (message) => warnings.push(message);
    assert.equal(parseTimeout(undefined, warn), DEFAULT_TIMEOUT_MS);
    assert.equal(parseTimeout("", warn), DEFAULT_TIMEOUT_MS);
    assert.equal(parseTimeout("2500", warn), 2500);
    assert.equal(parseTimeout(String(MAX_TIMEOUT_MS), warn), MAX_TIMEOUT_MS);
    assert.equal(warnings.length, 0);
    for (const bad of ["-5", "99", "30000", "1.5", "abc"]) assert.equal(parseTimeout(bad, warn), DEFAULT_TIMEOUT_MS, bad);
    assert.equal(warnings.length, 5);
  });

  test("resolveLogPath expands ~, refuses relative paths and follows XDG_STATE_HOME only when absolute", () => {
    const warnings = [];
    const warn = (message) => warnings.push(message);
    const home = "/home/me";
    const at = (env, platform = "linux") => resolveLogPath({ env, platform, home }, warn);
    assert.equal(at({ OAI_SEARCH_LAUNCHER_LOG: "off" }), null);
    assert.equal(at({ OAI_SEARCH_LAUNCHER_LOG: "~/logs/l.log" }), "/home/me/logs/l.log");
    assert.equal(at({ OAI_SEARCH_LAUNCHER_LOG: "/var/l.log" }), "/var/l.log");
    assert.equal(at({}, "darwin"), "/home/me/Library/Logs/oai-search-mcp/launcher.log");
    assert.equal(at({ XDG_STATE_HOME: "/state" }), "/state/oai-search-mcp/launcher.log");
    assert.equal(at({ XDG_STATE_HOME: "relative" }), "/home/me/.local/state/oai-search-mcp/launcher.log");
    assert.equal(warnings.length, 0);
    assert.equal(at({ OAI_SEARCH_LAUNCHER_LOG: "logs/l.log" }), "/home/me/.local/state/oai-search-mcp/launcher.log");
    assert.equal(warnings.length, 1);
  });
});

describe("launcher", { skip: !hasZsh && "zsh is not installed" }, () => {
  before(() => assert.ok(existsSync(builtServer), "build/index.js is missing: run `pnpm build` (pnpm test does)"));

  function launcherEnv(home, extra = {}) {
    return envFor(home, { LOG_LEVEL: "info", OAI_SEARCH_LAUNCHER_LOG: path.join(home, "launcher.log"), ...extra });
  }

  /** launcher.log records; success records are written asynchronously, so wait for them. */
  async function records(home, count = 1) {
    const file = path.join(home, "launcher.log");
    const deadline = Date.now() + 5000;
    for (;;) {
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
      if (lines.length >= count) return lines.map((line) => JSON.parse(line));
      if (Date.now() > deadline) throw new Error(`launcher.log has ${lines.length} of ${count} records`);
      await sleep(25);
    }
  }

  /** JSON log lines (launcher and server) on stderr. */
  function events(stderr) {
    return stderr
      .split("\n")
      .filter((line) => line.startsWith("{"))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  const event = (stderr, name) => events(stderr).find((entry) => entry.event === name);

  async function connect(home, extraEnv = {}, args = [launcher]) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args,
      env: launcherEnv(home, extraEnv),
      stderr: "pipe",
    });
    let stderr = "";
    transport.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const client = new Client({ name: "launcher-test", version: "0.0.0" }, { capabilities: {} });
    await client.connect(transport);
    return { client, stderr: () => stderr };
  }

  /** A fake Responses API that answers every request with 401 and records its headers. */
  async function fakeApi() {
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push({
        authorization: req.headers.authorization,
        organization: req.headers["openai-organization"],
        project: req.headers["openai-project"],
      });
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "test", type: "invalid_request_error", code: "invalid_api_key" } }));
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return { seen, url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() };
  }

  const search = (client) => client.callTool({ name: "web-search", arguments: { input: "ping" } });

  test("the server sends the ~/.zshrc key to the API despite a noisy ~/.zshrc and a stale inherited key", async () => {
    const api = await fakeApi();
    const home = fakeHome(["echo NOISE", "read -t 1 line", "export OPENAI_API_KEY=sk-test-e2e"].join("\n"));
    const { client, stderr } = await connect(home, {
      OPENAI_API_KEY: "sk-test-stale",
      OPENAI_BASE_URL: api.url,
      OPENAI_MAX_RETRIES: "0",
    });
    try {
      const { tools } = await client.listTools();
      const webSearch = tools.find((tool) => tool.name === "web-search");
      assert.ok(webSearch, "web-search is not listed");
      const effort = webSearch.inputSchema.properties.reasoningEffort;
      assert.deepEqual(effort.enum, ["none", "low", "medium", "high", "xhigh", "max"]);
      assert.match(effort.description, /Server default: 'high'/);
      await search(client);
      assert.ok(api.seen.length > 0, "the server never called the API");
      assert.ok(api.seen.every((h) => h.authorization === "Bearer sk-test-e2e"), `saw ${api.seen.map((h) => h.authorization?.slice(0, 16))}`);
      assert.equal(event(stderr(), "launcher_key_loaded")?.sha256, fingerprint("sk-test-e2e"));
      const [entry] = await records(home);
      assert.equal(entry.source, "zshrc");
      assert.equal(entry.sha256, fingerprint("sk-test-e2e"));
      assert.ok(!readFileSync(path.join(home, "launcher.log"), "utf8").includes("sk-test"), "the log holds a key");
    } finally {
      await client.close();
      api.close();
    }
  });

  test("re-reads ~/.zshrc after a 401 and retries that request once with the rotated key", async () => {
    const api = await fakeApi();
    const home = fakeHome("export OPENAI_API_KEY=sk-test-old\n");
    const { client, stderr } = await connect(home, { OPENAI_BASE_URL: api.url, OPENAI_MAX_RETRIES: "0" });
    try {
      writeFileSync(path.join(home, ".zshrc"), "export OPENAI_API_KEY=sk-test-new\nexport OPENAI_ORG_ID=org-test-new\n");
      await search(client);
      assert.deepEqual(api.seen.map((h) => h.authorization), ["Bearer sk-test-old", "Bearer sk-test-new"]);
      assert.equal(api.seen[1].organization, "org-test-new");
      const rotated = event(stderr(), "api_key_rotated");
      assert.deepEqual([rotated?.from, rotated?.to], [fingerprint("sk-test-old"), fingerprint("sk-test-new")]);
      const refresh = (await records(home, 2)).find((entry) => entry.event === "refresh");
      assert.equal(refresh?.sha256, fingerprint("sk-test-new"));

      // The rotated key is used directly from now on, and a 401 on it is not retried.
      api.seen.length = 0;
      await search(client);
      assert.deepEqual(api.seen.map((h) => h.authorization), ["Bearer sk-test-new"]);
    } finally {
      await client.close();
      api.close();
    }
  });

  test("without the launcher a 401 is returned as before, with no retry", async () => {
    const api = await fakeApi();
    const { client } = await connect(
      fakeHome(""),
      { OPENAI_API_KEY: "sk-test-direct", OPENAI_BASE_URL: api.url, OPENAI_MAX_RETRIES: "0" },
      [builtServer],
    );
    try {
      await search(client);
      assert.deepEqual(api.seen.map((h) => h.authorization), ["Bearer sk-test-direct"]);
    } finally {
      await client.close();
      api.close();
    }
  });

  test("takes OPENAI_ORG_ID, OPENAI_PROJECT_ID and OPENAI_BASE_URL from ~/.zshrc over the client's", async () => {
    const api = await fakeApi();
    const home = fakeHome(
      `export OPENAI_API_KEY=sk-test-org\nexport OPENAI_ORG_ID=org-zshrc\nexport OPENAI_PROJECT_ID=proj_zshrc\nexport OPENAI_BASE_URL=${api.url}\n`,
    );
    const { client, stderr } = await connect(home, {
      OPENAI_ORG_ID: "org-stale",
      OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
      OPENAI_MAX_RETRIES: "0",
    });
    try {
      await search(client);
      assert.equal(api.seen[0]?.organization, "org-zshrc");
      assert.equal(api.seen[0]?.project, "proj_zshrc");
      assert.deepEqual(event(stderr(), "launcher_key_loaded")?.settings, ["OPENAI_ORG_ID", "OPENAI_PROJECT_ID", "OPENAI_BASE_URL"]);
    } finally {
      await client.close();
      api.close();
    }
  });

  test("serves the system prompt with the model name filled in", async () => {
    const { MODEL } = await import(pathToFileURL(path.join(here, "..", "build", "ptc-search.js")).href);
    const { client } = await connect(fakeHome("export OPENAI_API_KEY=sk-test-prompt\n"));
    try {
      const { contents } = await client.readResource({ uri: "web-search://system-prompt" });
      const text = contents.map((item) => item.text ?? "").join("\n");
      assert.ok(text.includes(`powered by ${MODEL}`), "the prompt does not name the model");
      assert.ok(!text.includes("{{MODEL}}"), "the prompt still has the placeholder");
    } finally {
      await client.close();
    }
  });

  test("falls back to the inherited key loudly, even at LOG_LEVEL=error", async () => {
    const home = fakeHome("# no key\n");
    const { client, stderr } = await connect(home, { OPENAI_API_KEY: "sk-test-inherited", LOG_LEVEL: "error" });
    try {
      await client.listTools();
      const fallback = event(stderr(), "launcher_key_fallback");
      assert.equal(fallback?.level, "error");
      assert.equal(fallback?.sha256, fingerprint("sk-test-inherited"));
      assert.match(fallback?.message ?? "", /may be stale/);
      assert.equal((await records(home))[0].source, "inherited");
    } finally {
      await client.close();
    }
  });

  test("exits with an error and a log record when no key is available", async () => {
    const home = fakeHome("# no key\n");
    const run = spawnSync(process.execPath, [launcher], {
      env: launcherEnv(home, { LOG_LEVEL: "error" }),
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    assert.match(event(run.stderr, "launcher_error")?.message ?? "", /could not read OPENAI_API_KEY from ~\/.zshrc .*none was inherited/);
    const [entry] = await records(home);
    assert.equal(entry.source, "none");
    assert.match(entry.reason, /not set/);
  });

  test("logs an interruption by SIGTERM during the probe", { timeout: 20_000 }, async () => {
    const home = fakeHome(HANGING_RC);
    const child = spawn(process.execPath, [launcher], { env: launcherEnv(home), stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const zshPid = Number(await waitForFile(path.join(home, "zsh.pid")));
    child.kill("SIGTERM");
    const [, signal] = await new Promise((r) => child.on("exit", (c, s) => r([c, s])));
    assert.equal(signal, "SIGTERM");
    assert.match(event(stderr, "launcher_error")?.message ?? "", /interrupted by SIGTERM while reading ~\/.zshrc/);
    const [entry] = await records(home);
    assert.equal(entry.source, "none");
    assert.match(entry.reason, /interrupted by SIGTERM/);
    assert.ok(await waitDead(zshPid), "the probe zsh outlived the launcher");
  });

  test("keeps logging at info when LOG_LEVEL names an Object.prototype member", async () => {
    const { client, stderr } = await connect(fakeHome("export OPENAI_API_KEY=sk-test-proto\n"), { LOG_LEVEL: "constructor" });
    try {
      await client.listTools();
      assert.ok(event(stderr(), "launcher_key_loaded"), "no launcher_key_loaded line");
    } finally {
      await client.close();
    }
  });

  test("refuses a FIFO as launcher.log without blocking", { timeout: 20_000 }, async () => {
    const home = fakeHome("export OPENAI_API_KEY=sk-test-logpath\n");
    const fifo = path.join(home, "fifo.log");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    const { client, stderr } = await connect(home, { OAI_SEARCH_LAUNCHER_LOG: fifo });
    try {
      await client.listTools();
      const deadline = Date.now() + 5000;
      while (!/not a regular file/.test(stderr()) && Date.now() < deadline) await sleep(25);
      assert.match(event(stderr(), "launcher_warning")?.message ?? "", /not logging to .*fifo\.log: it is not a regular file/);
    } finally {
      await client.close();
    }
  });

  test("refuses a malformed inherited key instead of falling back to it", async () => {
    const home = fakeHome("# no key\n");
    const run = spawnSync(process.execPath, [launcher], {
      env: launcherEnv(home, { OPENAI_API_KEY: "sk-test a" }),
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /inherited environment contains whitespace/);
    assert.equal((await records(home))[0].source, "none");
  });

  test("reports a missing server build clearly and logs it", async () => {
    const home = fakeHome("export OPENAI_API_KEY=sk-test-nobuild\n");
    const copy = path.join(home, "pkg", "bin");
    mkdirSync(copy, { recursive: true });
    for (const file of ["oai-search-mcp.mjs", "zshrc-key.mjs", "launcher-config.mjs"]) {
      copyFileSync(path.join(here, file), path.join(copy, file));
    }
    const run = spawnSync(process.execPath, [path.join(copy, "oai-search-mcp.mjs")], {
      env: launcherEnv(home),
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    assert.match(event(run.stderr, "launcher_error")?.message ?? "", /could not load the server .*run `pnpm build`/);
    const [entry] = await records(home);
    assert.equal(entry.source, "zshrc");
    assert.ok(entry.serverError, "the log has no serverError");
  });
});
