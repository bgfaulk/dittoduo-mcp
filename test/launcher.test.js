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
  child.exitCode = null;
  child.signalCode = null;
  child.killed = [];
  child.kill = (s) => child.killed.push(s);
  return child;
}

// Builds deps where `installed` lists the paths that exist.
function deps({ installed = [], env = {}, signed = true } = {}) {
  const proc = fakeProc();
  const calls = { verified: [], spawned: [] };
  const child = fakeChild();
  return {
    proc,
    calls,
    child,
    overrides: {
      env,
      homedir: () => HOME,
      isExecutableFile: (p) => installed.includes(p),
      verifySignature: (p) => {
        calls.verified.push(p);
        return signed;
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
  assert.deepEqual(d.calls.spawned[0].opts, { stdio: "inherit" });
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
    d.child.emit("exit", code, null);
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
  d.child.emit("exit", null, "SIGTERM");
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

test("signing requirement pins the identifier and team ID", () => {
  assert.equal(
    launcher.REQUIREMENT,
    'identifier "com.501coding.dittoduo.mcp" and anchor apple generic' +
      ' and certificate leaf[subject.OU] = "473BT83344"',
  );
});

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
      ".main({ verifySignature: () => true });\n",
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
