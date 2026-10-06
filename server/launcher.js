#!/usr/bin/env node
// DittoDuo MCP launcher.
//
// Finds the MCP helper that ships inside DittoDuo.app, checks its code
// signature, runs it, re-checks the signature of the running process, and then
// pipes this process's stdin/stdout/stderr to it. It does not implement any MCP
// itself and has no dependencies.
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HELPER_SUBPATH = "DittoDuo.app/Contents/Helpers/DittoDuoMCP";
const SIGNING_IDENTIFIER = "com.501coding.dittoduo.mcp";
const TEAM_ID = "473BT83344";
// Developer ID only: an Apple-issued chain whose intermediate is the Developer
// ID CA (1.2.840.113635.100.6.2.6) and whose leaf is a Developer ID
// Application certificate (1.2.840.113635.100.6.1.13), for DittoDuo's team.
const REQUIREMENT =
  `identifier "${SIGNING_IDENTIFIER}" and anchor apple generic` +
  " and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */" +
  " and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */" +
  ` and certificate leaf[subject.OU] = "${TEAM_ID}"`;
// Any Apple-issued certificate for the team, including Apple Development. Used
// only when DITTODUO_ALLOW_DEVELOPMENT_SIGNATURE=1, for testing local builds.
const REQUIREMENT_DEVELOPMENT =
  `identifier "${SIGNING_IDENTIFIER}" and anchor apple generic` +
  ` and certificate leaf[subject.OU] = "${TEAM_ID}"`;
const ALLOW_DEVELOPMENT_ENV = "DITTODUO_ALLOW_DEVELOPMENT_SIGNATURE";
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

function requirementFor(env) {
  return env[ALLOW_DEVELOPMENT_ENV] === "1" ? REQUIREMENT_DEVELOPMENT : REQUIREMENT;
}

// `target` is a file path or the pid of running code; `codesign` accepts both.
function codesignVerify(target, requirement) {
  const r = childProcess.spawnSync(
    CODESIGN,
    ["--verify", "--strict", `-R=${requirement}`, String(target)],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

// Returns true when the helper file at `p` satisfies `requirement`.
function verifySignature(p, requirement) {
  return codesignVerify(p, requirement);
}

// Returns true when the running process `pid` satisfies `requirement`. This
// closes the gap between checking the file and running it: whatever was
// actually executed is what gets checked.
function verifyRunning(pid, requirement) {
  return codesignVerify(pid, requirement);
}

const defaultDeps = {
  env: process.env,
  homedir: () => os.homedir(),
  isExecutableFile,
  verifySignature,
  verifyRunning,
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

  const requirement = requirementFor(env);
  if (!deps.verifySignature(helper, requirement)) return fail(deps, MSG_BAD_SIGNATURE);

  // Pipe, don't inherit: hosts that run the launcher inside their own Node runtime
  // (Claude Desktop's built-in Node) give it stdin/stdout streams that are not
  // file descriptors 0 and 1, so an inherited helper would never see a message.
  const child = deps.spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });

  // Check the running process before it sees any input. The helper does nothing
  // until its first message, so nothing has run when this check completes. With
  // no pid the spawn failed; the "error" handler below reports it.
  if (child.pid !== undefined && !deps.verifyRunning(child.pid, requirement)) {
    child.kill("SIGKILL");
    return fail(deps, MSG_BAD_SIGNATURE);
  }

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
  REQUIREMENT_DEVELOPMENT,
  ALLOW_DEVELOPMENT_ENV,
  requirementFor,
  verifyRunning,
  MSG_NOT_INSTALLED,
  MSG_BAD_SIGNATURE,
  MSG_BAD_ENV,
  isEntryPoint,
};

// True when this file is the program being run. `require.main === module` is
// not enough: Claude Desktop's built-in Node loads the entry point with
// `import()`, which leaves `require.main` pointing at its own host script, so
// the launcher would never start and the host would time out on `initialize`.
function isEntryPoint(argv1, filename) {
  if (!argv1) return false;
  const real = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(argv1) === real(filename);
}

if (require.main === module || isEntryPoint(process.argv[1], __filename)) main();
