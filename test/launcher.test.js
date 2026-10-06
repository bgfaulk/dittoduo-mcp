"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const launcher = require("../server/launcher.js");

const APP_HELPER = "/Applications/DittoDuo.app/Contents/Helpers/DittoDuoMCP";
const HOME = "/Users/example";
const USER_HELPER = `${HOME}/Applications/DittoDuo.app/Contents/Helpers/DittoDuoMCP`;

function fakeProc() {
  const proc = new EventEmitter();
  proc.pid = 4242;
  proc.stderrText = "";
  proc.stderr = { write: (s) => (proc.stderrText += s) };
  proc.exitCodes = [];
  proc.exit = (code) => proc.exitCodes.push(code);
  proc.kills = [];
  proc.kill = (pid, signal) => proc.kills.push([pid, signal]);
  return proc;
}

function fakeChild() {
  const child = new EventEmitter();
  child.pid = 5151;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (s) => child.killed.push(s);
  return child;
}

// Builds deps where `installed` lists the paths that exist.
function deps({ installed = [], env = {}, signed = true, runningSigned = true } = {}) {
  const proc = fakeProc();
  proc.stdin = { pipes: [], pipe: (dest) => proc.stdin.pipes.push(dest) };
  const calls = { verified: [], requirements: [], running: [], spawned: [] };
  const child = fakeChild();
  child.stdin = { on: () => {} };
  return {
    proc,
    calls,
    child,
    overrides: {
      env,
      homedir: () => HOME,
      isExecutableFile: (p) => installed.includes(p),
      verifySignature: (p, requirement) => {
        calls.verified.push(p);
        calls.requirements.push(requirement);
        return signed;
      },
      verifyRunning: (pid, requirement) => {
        calls.running.push([pid, requirement]);
        return runningSigned;
      },
      spawn: (cmd, args, opts) => {
        calls.spawned.push({ cmd, args, opts });
        return child;
      },
      proc,
    },
  };
}

test("prefers the /Applications copy", () => {
  const d = deps({ installed: [APP_HELPER, USER_HELPER] });
  launcher.main(d.overrides);
  assert.deepEqual(d.calls.verified, [APP_HELPER]);
  assert.equal(d.calls.spawned[0].cmd, APP_HELPER);
  assert.deepEqual(d.calls.spawned[0].args, []);
  assert.deepEqual(d.calls.spawned[0].opts, { stdio: ["pipe", "pipe", "pipe"] });
});

test("falls back to ~/Applications", () => {
  const d = deps({ installed: [USER_HELPER] });
  launcher.main(d.overrides);
  assert.equal(d.calls.spawned[0].cmd, USER_HELPER);
});

test("honours $DITTODUO_HELPER first", () => {
  const custom = "/Volumes/Apps/DittoDuo.app/Contents/Helpers/DittoDuoMCP";
  const d = deps({
    installed: [custom, APP_HELPER],
    env: { DITTODUO_HELPER: custom },
  });
  launcher.main(d.overrides);
  assert.deepEqual(d.calls.verified, [custom]);
  assert.equal(d.calls.spawned[0].cmd, custom);
});

test("rejects a relative $DITTODUO_HELPER", () => {
  const d = deps({
    installed: [APP_HELPER],
    env: { DITTODUO_HELPER: "DittoDuoMCP" },
  });
  launcher.main(d.overrides);
  assert.deepEqual(d.proc.exitCodes, [1]);
  assert.match(d.proc.stderrText, /absolute path/);
  assert.equal(d.calls.spawned.length, 0);
});

test("helper missing: install message on stderr, exit 1", () => {
  const d = deps({ installed: [] });
  launcher.main(d.overrides);
  assert.deepEqual(d.proc.exitCodes, [1]);
  assert.equal(
    d.proc.stderrText,
    `dittoduo-mcp: ${launcher.MSG_NOT_INSTALLED}\n`,
  );
  assert.equal(d.calls.verified.length, 0);
  assert.equal(d.calls.spawned.length, 0);
});

test("signature check fails: signature message on stderr, exit 1, no spawn", () => {
  const d = deps({ installed: [APP_HELPER], signed: false });
  launcher.main(d.overrides);
  assert.deepEqual(d.proc.exitCodes, [1]);
  assert.equal(
    d.proc.stderrText,
    `dittoduo-mcp: ${launcher.MSG_BAD_SIGNATURE}\n`,
  );
  assert.equal(d.calls.spawned.length, 0);
});

test("success: forwards the helper's exit code", () => {
  for (const code of [0, 3]) {
    const d = deps({ installed: [APP_HELPER] });
    launcher.main(d.overrides);
    d.child.emit("close", code, null);
    assert.deepEqual(d.proc.exitCodes, [code]);
    assert.equal(d.proc.stderrText, "");
  }
});

test("success: passes SIGTERM and SIGINT to the helper", () => {
  const d = deps({ installed: [APP_HELPER] });
  launcher.main(d.overrides);
  d.proc.emit("SIGTERM", "SIGTERM");
  d.proc.emit("SIGINT", "SIGINT");
  assert.deepEqual(d.child.killed, ["SIGTERM", "SIGINT"]);
});

test("helper killed by a signal: launcher re-raises it", () => {
  const d = deps({ installed: [APP_HELPER] });
  launcher.main(d.overrides);
  d.child.emit("close", null, "SIGTERM");
  assert.deepEqual(d.proc.kills, [[4242, "SIGTERM"]]);
  assert.equal(d.proc.listenerCount("SIGTERM"), 0);
});

test("spawn error: message on stderr, exit 1", () => {
  const d = deps({ installed: [APP_HELPER] });
  launcher.main(d.overrides);
  d.child.emit("error", new Error("EACCES"));
  assert.deepEqual(d.proc.exitCodes, [1]);
  assert.match(d.proc.stderrText, /could not start the DittoDuo helper \(EACCES\)/);
});

test("signing requirement pins the identifier, team ID and Developer ID", () => {
  assert.equal(
    launcher.REQUIREMENT,
    'identifier "com.501coding.dittoduo.mcp" and anchor apple generic' +
      " and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */" +
      " and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */" +
      ' and certificate leaf[subject.OU] = "473BT83344"',
  );
  assert.equal(
    launcher.REQUIREMENT_DEVELOPMENT,
    'identifier "com.501coding.dittoduo.mcp" and anchor apple generic' +
      ' and certificate leaf[subject.OU] = "473BT83344"',
  );
});

test("Developer ID is required unless development signatures are opted into", () => {
  assert.equal(launcher.requirementFor({}), launcher.REQUIREMENT);
  assert.equal(
    launcher.requirementFor({ DITTODUO_ALLOW_DEVELOPMENT_SIGNATURE: "true" }),
    launcher.REQUIREMENT,
  );
  assert.equal(
    launcher.requirementFor({ DITTODUO_ALLOW_DEVELOPMENT_SIGNATURE: "1" }),
    launcher.REQUIREMENT_DEVELOPMENT,
  );
  const d = deps({
    installed: [APP_HELPER],
    env: { DITTODUO_ALLOW_DEVELOPMENT_SIGNATURE: "1" },
  });
  launcher.main(d.overrides);
  assert.deepEqual(d.calls.requirements, [launcher.REQUIREMENT_DEVELOPMENT]);
  assert.deepEqual(d.calls.running, [[5151, launcher.REQUIREMENT_DEVELOPMENT]]);
});

test("re-verifies the running helper by pid before piping stdin to it", () => {
  const d = deps({ installed: [APP_HELPER] });
  launcher.main(d.overrides);
  assert.deepEqual(d.calls.requirements, [launcher.REQUIREMENT]);
  assert.deepEqual(d.calls.running, [[5151, launcher.REQUIREMENT]]);
  assert.deepEqual(d.proc.stdin.pipes, [d.child.stdin]);
  assert.deepEqual(d.child.killed, []);
});

test("running helper fails its signature check: killed, message on stderr, exit 1, no input", () => {
  const d = deps({ installed: [APP_HELPER], runningSigned: false });
  launcher.main(d.overrides);
  assert.deepEqual(d.child.killed, ["SIGKILL"]);
  assert.deepEqual(d.proc.exitCodes, [1]);
  assert.equal(d.proc.stderrText, `dittoduo-mcp: ${launcher.MSG_BAD_SIGNATURE}\n`);
  assert.deepEqual(d.proc.stdin.pipes, []);
  assert.equal(d.child.listenerCount("close"), 0);
});

test(
  "real codesign checks a running process by pid",
  { skip: process.platform !== "darwin" && "needs macOS codesign" },
  async () => {
    const sleeper = childProcess.spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    try {
      assert.equal(
        launcher.verifyRunning(sleeper.pid, 'identifier "com.apple.sleep" and anchor apple'),
        true,
      );
      assert.equal(launcher.verifyRunning(sleeper.pid, launcher.REQUIREMENT), false);
    } finally {
      sleeper.kill("SIGKILL");
    }
  },
);

// --- Process-level tests -------------------------------------------------

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dittoduo-mcp-test-"));
}

// A stand-in helper: copies stdin to stdout, then exits with $STUB_EXIT.
function writeStub(dir) {
  const stub = path.join(dir, "DittoDuoMCP");
  fs.writeFileSync(
    stub,
    `#!${process.execPath}\n` +
      "process.stdin.pipe(process.stdout);\n" +
      "process.stdin.on('end', () => process.exit(Number(process.env.STUB_EXIT || 0)));\n",
  );
  fs.chmodSync(stub, 0o755);
  return stub;
}

// Runs the real launcher with only the signature check replaced.
function writeHarness(dir) {
  const harness = path.join(dir, "harness.js");
  fs.writeFileSync(
    harness,
    `require(${JSON.stringify(path.resolve(__dirname, "../server/launcher.js"))})` +
      ".main({ verifySignature: () => true, verifyRunning: () => true });\n",
  );
  return harness;
}

test("stdio pass-through is byte-for-byte and the exit code comes back", () => {
  const dir = tmpDir();
  const stub = writeStub(dir);
  const harness = writeHarness(dir);
  const input =
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) +
    "\n";
  const r = childProcess.spawnSync(process.execPath, [harness], {
    input,
    env: { ...process.env, DITTODUO_HELPER: stub, STUB_EXIT: "7" },
  });
  assert.equal(r.stdout.toString("utf8"), input);
  assert.equal(r.stderr.toString("utf8"), "");
  assert.equal(r.status, 7);
});

test(
  "real codesign rejects an unsigned helper",
  { skip: process.platform !== "darwin" && "needs macOS codesign" },
  () => {
    const dir = tmpDir();
    const stub = writeStub(dir);
    const r = childProcess.spawnSync(
      process.execPath,
      [path.resolve(__dirname, "../server/launcher.js")],
      { input: "", env: { ...process.env, DITTODUO_HELPER: stub } },
    );
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr.toString("utf8"),
      `dittoduo-mcp: ${launcher.MSG_BAD_SIGNATURE}\n`,
    );
    assert.equal(r.stdout.length, 0);
  },
);

test("host streams that are not fds 0/1 (Claude Desktop's built-in Node) still reach the helper", async () => {
  const { PassThrough } = require("node:stream");
  const dir = tmpDir();
  const stub = writeStub(dir);
  const proc = fakeProc();
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  let out = "";
  proc.stdout.on("data", (c) => (out += c));
  const exited = new Promise((resolve) => (proc.exit = resolve));
  launcher.main({
    env: { DITTODUO_HELPER: stub },
    verifySignature: () => true,
    verifyRunning: () => true,
    proc,
  });
  const input = JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize" }) + "\n";
  proc.stdin.end(input);
  assert.equal(await exited, 0);
  assert.equal(out, input);
});

test("starts when the host loads it with import() (Claude Desktop's built-in Node)", () => {
  const dir = tmpDir();
  const stub = writeStub(dir);
  const entry = path.resolve(__dirname, "../server/launcher.js");
  const { pathToFileURL } = require("node:url");
  // Mirrors Claude Desktop's node host: argv[1] is the entry, loaded via import().
  const script =
    `process.argv = ["node", ${JSON.stringify(entry)}];` +
    `await import(${JSON.stringify(pathToFileURL(entry).href)});`;
  const r = childProcess.spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    { input: "", env: { ...process.env, DITTODUO_HELPER: stub }, timeout: 10000 },
  );
  // The stub isn't signed, so a launcher that ran refuses it; one that never ran is silent.
  assert.equal(r.status, 1);
  assert.equal(
    r.stderr.toString("utf8"),
    `dittoduo-mcp: ${launcher.MSG_BAD_SIGNATURE}\n`,
  );
});

test("isEntryPoint compares resolved paths", () => {
  const entry = path.resolve(__dirname, "../server/launcher.js");
  assert.equal(launcher.isEntryPoint(entry, entry), true);
  assert.equal(launcher.isEntryPoint(path.join(__dirname, "..", "server", "..", "server", "launcher.js"), entry), true);
  assert.equal(launcher.isEntryPoint(__filename, entry), false);
  assert.equal(launcher.isEntryPoint(undefined, entry), false);
});

test(
  "real pid check rejects an unsigned helper that passed a (faked) file check",
  { skip: process.platform !== "darwin" && "needs macOS codesign" },
  () => {
    const dir = tmpDir();
    const stub = writeStub(dir);
    const harness = path.join(dir, "harness-pid.js");
    fs.writeFileSync(
      harness,
      `require(${JSON.stringify(path.resolve(__dirname, "../server/launcher.js"))})` +
        ".main({ verifySignature: () => true });\n",
    );
    const r = childProcess.spawnSync(process.execPath, [harness], {
      input: "should never reach the helper\n",
      env: { ...process.env, DITTODUO_HELPER: stub },
      timeout: 10000,
    });
    assert.equal(r.status, 1);
    assert.equal(r.stderr.toString("utf8"), `dittoduo-mcp: ${launcher.MSG_BAD_SIGNATURE}\n`);
    assert.equal(r.stdout.length, 0);
  },
);
