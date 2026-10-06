#!/usr/bin/env node
// Usage: node scripts/set-release.js [--no-npm] <tag> <path/to/dittoduo.mcpb> <owner/repo>
// Checks that the tag matches every version field (and the version pinned in
// README.md), then writes the release URL and the bundle's SHA-256 into
// server.json. --no-npm drops the npm package from the written server.json, so
// the Registry entry can be published while the npm package does not exist.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const noNpm = args.includes("--no-npm");
const [tag, bundle, repo] = args.filter((a) => a !== "--no-npm");
if (!tag || !bundle || !repo) {
  console.error("usage: set-release.js [--no-npm] <tag> <bundle.mcpb> <owner/repo>");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
const version = tag.replace(/^v/, "");

const server = read("server.json");
const found = {
  "package.json": read("package.json").version,
  "manifest.json": read("manifest.json").version,
  "server.json": server.version,
};
for (const p of server.packages) {
  if (p.version) found[`server.json ${p.registryType}`] = p.version;
}
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const pins = [...readme.matchAll(/@dittoduo\/mcp@(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
found["README.md pinned version"] =
  pins.find((v) => v !== version) ?? (pins.length ? version : "(none)");
const wrong = Object.entries(found).filter(([, v]) => v !== version);
if (wrong.length) {
  for (const [f, v] of wrong) console.error(`${f} has version ${v}, tag is ${tag}`);
  process.exit(1);
}

const sha = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
const mcpb = server.packages.find((p) => p.registryType === "mcpb");
mcpb.identifier = `https://github.com/${repo}/releases/download/${tag}/${path.basename(bundle)}`;
mcpb.fileSha256 = sha;
if (noNpm) server.packages = server.packages.filter((p) => p.registryType !== "npm");
fs.writeFileSync(path.join(root, "server.json"), JSON.stringify(server, null, 2) + "\n");
console.log(`${path.basename(bundle)} sha256 ${sha}${noNpm ? " (npm package omitted)" : ""}`);
