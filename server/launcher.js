#!/usr/bin/env node
// DittoDuo MCP launcher.
//
// Finds the MCP helper that ships inside DittoDuo.app, checks its code
// signature, and runs it with this process's stdin/stdout/stderr. It does not
// implement any MCP itself and has no dependencies.
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HELPER_SUBPATH = "DittoDuo.app/Contents/Helpers/DittoDuoMCP";
const SIGNING_IDENTIFIER = "com.501coding.dittoduo.mcp";
const TEAM_ID = "473BT83344";
const REQUIREMENT =
  `identifier "${SIGNING_IDENTIFIER}" and anchor apple generic` +
  ` and certificate leaf[subject.OU] = "${TEAM_ID}"`;
const CODESIGN = "/usr/bin/codesign";

const MSG_NOT_INSTALLED =
  "DittoDuo isn't installed. Get it at https://dittoduo.io/download";
const MSG_BAD_ENV =
  "DITTODUO_HELPER must be an absolute path to the DittoDuoMCP helper.";
const MSG_BAD_SIGNATURE =
  "The DittoDuo helper failed its signature check; reinstall DittoDuo.";

// Candidate helper paths, in the order they are tried.
function candidatePaths(env, homedir) {
  const list = [];
  if (env.DITTODUO_HELPER) list.push(env.DITTODUO_HELPER);
  list.push(path.join("/Applications", HELPER_SUBPATH));
  if (homedir) list.push(path.join(homedir, "Applications", HELPER_SUBPATH));
  return list;
}

function isExecutableFile(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Returns true when the helper at `p` is signed by DittoDuo's Developer ID.
function verifySignature(p) {
  const r = childProcess.spawnSync(
    CODESIGN,
    ["--verify", "--strict", `-R=${REQUIREMENT}`, p],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

const defaultDeps = {
  env: process.env,
  homedir: () => os.homedir(),
  isExecutableFile,
  verifySignature,
  spawn: childProcess.spawn,
  proc: process,
};

function fail(deps, message) {
  deps.proc.stderr.write(`dittoduo-mcp: ${message}\n`);
  deps.proc.exit(1);
}

// Runs the launcher. Every side effect goes through `deps` so tests can
// replace it.
function main(overrides = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const { env, proc } = deps;

  if (env.DITTODUO_HELPER && !path.isAbsolute(env.DITTODUO_HELPER)) {
    return fail(deps, MSG_BAD_ENV);
  }

  const helper = candidatePaths(env, deps.homedir()).find((p) =>
    deps.isExecutableFile(p),
  );
  if (!helper) return fail(deps, MSG_NOT_INSTALLED);

  if (!deps.verifySignature(helper)) return fail(deps, MSG_BAD_SIGNATURE);

  // Pipe, don't inherit: hosts that run the launcher inside their own Node runtime
  // (Claude Desktop's built-in Node) give it stdin/stdout streams that are not
  // file descriptors 0 and 1, so an inherited helper would never see a message.
  const child = deps.spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
  if (child.stdin && proc.stdin) {
    child.stdin.on("error", () => {}); // the helper exited first; "close" reports it
    proc.stdin.pipe(child.stdin);
  }
  if (child.stdout && proc.stdout) child.stdout.pipe(proc.stdout);
  if (child.stderr) child.stderr.on("data", (chunk) => proc.stderr.write(chunk));

  const forward = (signal) => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
  for (const s of signals) proc.on(s, forward);

  child.on("error", (err) => {
    fail(deps, `could not start the DittoDuo helper (${err.message}).`);
  });

  // "close", not "exit": it fires after the helper's stdout is drained, so the
  // last reply reaches the host before the launcher exits.
  child.on("close", (code, signal) => {
    for (const s of signals) proc.removeListener(s, forward);
    if (code !== null) return proc.exit(code);
    // The helper was killed by a signal: end the same way so the host sees it.
    try {
      proc.kill(proc.pid, signal);
    } catch {
      // Fall through to a plain failure exit.
    }
    proc.exit(1);
  });

  return child;
}

module.exports = {
  main,
  candidatePaths,
  REQUIREMENT,
  MSG_NOT_INSTALLED,
  MSG_BAD_SIGNATURE,
  MSG_BAD_ENV,
};

if (require.main === module) main();
