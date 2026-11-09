import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { classify, fingerprint, readKeyFromZshrc, redact, shellEnv } from "./zshrc-key.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "oai-search-mcp.mjs");
const moduleUrl = new URL("./zshrc-key.mjs", import.meta.url).href;
const builtServer = path.join(here, "..", "build", "index.js");
const hasZsh = existsSync("/bin/zsh");
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
      { HOME: "/h", PATH: "/p", USER: "u", TMUX: "t", SSH_AUTH_SOCK: "s", OPENAI_API_KEY: "sk-x", ZDOTDIR: "/z" },
      "/bin/zsh",
    );
    assert.equal(env.TMUX, "t");
    assert.equal(env.SSH_AUTH_SOCK, "s");
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ZDOTDIR, undefined);
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

  test("redact hides token-like strings of 16 or more characters", () => {
    assert.equal(redact("x sk-abcdefghijklmnop y"), "x [redacted] y");
    assert.equal(redact("/Users/me/.zshrc:12: command not found: foo"), "/Users/me/.zshrc:12: command not found: foo");
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
    await sleep(200);
    assert.equal(pidAlive(pid), false, "the hung zsh is still running");
  });

  test("kills the shell and still dies by the signal when SIGTERM arrives during the probe", async () => {
    const home = fakeHome("print $$ > $HOME/zsh.pid\nsleep 30\n");
    const code = `import {readKeyFromZshrc} from ${JSON.stringify(moduleUrl)}; await readKeyFromZshrc({timeoutMs: 60000});`;
    const wrapper = spawn(process.execPath, ["--input-type=module", "-e", code], {
      env: isolatedEnv(home),
      stdio: "ignore",
    });
    const zshPid = Number(await waitForFile(path.join(home, "zsh.pid")));
    wrapper.kill("SIGTERM");
    const [exitCode, signal] = await new Promise((r) => wrapper.on("exit", (c, s) => r([c, s])));
    assert.equal(signal, "SIGTERM", `wrapper exited with code ${exitCode}`);
    await sleep(200);
    assert.equal(pidAlive(zshPid), false, "the probe zsh outlived its parent");
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

describe("launcher", { skip: !hasZsh && "zsh is not installed" }, () => {
  before(() => assert.ok(existsSync(builtServer), "build/index.js is missing: run `pnpm build` (pnpm test does)"));

  function launcherEnv(home, extra = {}) {
    return envFor(home, { LOG_LEVEL: "info", OAI_SEARCH_LAUNCHER_LOG: path.join(home, "launcher.log"), ...extra });
  }

  function records(home) {
    return readFileSync(path.join(home, "launcher.log"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  }

  async function connect(home, extraEnv) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [launcher],
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

  test("the server sends the ~/.zshrc key to the API despite a noisy ~/.zshrc and a stale inherited key", async () => {
    const seen = [];
    const api = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      req.resume();
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "test", type: "invalid_request_error", code: "invalid_api_key" } }));
    });
    await new Promise((r) => api.listen(0, "127.0.0.1", r));
    const home = fakeHome(["echo NOISE", "read -t 1 line", "export OPENAI_API_KEY=sk-test-e2e"].join("\n"));
    const { client, stderr } = await connect(home, {
      OPENAI_API_KEY: "sk-test-stale",
      OPENAI_BASE_URL: `http://127.0.0.1:${api.address().port}/v1`,
      OPENAI_MAX_RETRIES: "0",
    });
    try {
      const { tools } = await client.listTools();
      assert.ok(tools.some((tool) => tool.name === "web-search"));
      await client.callTool({ name: "web-search", arguments: { input: "ping" } });
      assert.ok(seen.length > 0, "the server never called the API");
      assert.ok(seen.every((auth) => auth === "Bearer sk-test-e2e"), `saw ${seen.map((a) => a?.slice(0, 16))}`);
      assert.match(stderr(), new RegExp(`loaded from ~/.zshrc \\(sha256:${fingerprint("sk-test-e2e")}`));
      const [entry] = records(home);
      assert.equal(entry.source, "zshrc");
      assert.equal(entry.sha256, fingerprint("sk-test-e2e"));
      assert.ok(!readFileSync(path.join(home, "launcher.log"), "utf8").includes("sk-test"), "the log holds a key");
    } finally {
      await client.close();
      api.close();
    }
  });

  test("falls back to the inherited key loudly, even at LOG_LEVEL=error", async () => {
    const home = fakeHome("# no key\n");
    const { client, stderr } = await connect(home, { OPENAI_API_KEY: "sk-test-inherited", LOG_LEVEL: "error" });
    try {
      await client.listTools();
      assert.match(stderr(), new RegExp(`error: .*falling back .*sha256:${fingerprint("sk-test-inherited")}.*may be stale`));
      assert.equal(records(home)[0].source, "inherited");
    } finally {
      await client.close();
    }
  });

  test("exits with an error and a log record when no key is available", () => {
    const home = fakeHome("# no key\n");
    const run = spawnSync(process.execPath, [launcher], {
      env: launcherEnv(home, { LOG_LEVEL: "error" }),
      input: "",
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /error: could not read OPENAI_API_KEY from ~\/.zshrc .*none was inherited/);
    const [entry] = records(home);
    assert.equal(entry.source, "none");
    assert.match(entry.reason, /not set/);
  });

  test("ignores an invalid OAI_SEARCH_ZSHRC_TIMEOUT_MS", async () => {
    for (const bad of ["-5", "99999999999", "abc"]) {
      const home = fakeHome("export OPENAI_API_KEY=sk-test-timeout\n");
      const { client, stderr } = await connect(home, { OAI_SEARCH_ZSHRC_TIMEOUT_MS: bad });
      try {
        await client.listTools();
        assert.match(stderr(), /warn: ignoring OAI_SEARCH_ZSHRC_TIMEOUT_MS/);
        assert.equal(records(home)[0].source, "zshrc", `with ${bad}`);
      } finally {
        await client.close();
      }
    }
  });
});
