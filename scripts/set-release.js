#!/usr/bin/env node
// Usage: node scripts/set-release.js <tag> <path/to/dittoduo.mcpb> <owner/repo>
// Checks that the tag matches every version field, then writes the release
// URL and the bundle's SHA-256 into server.json.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const [tag, bundle, repo] = process.argv.slice(2);
if (!tag || !bundle || !repo) {
  console.error("usage: set-release.js <tag> <bundle.mcpb> <owner/repo>");
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
const wrong = Object.entries(found).filter(([, v]) => v !== version);
if (wrong.length) {
  for (const [f, v] of wrong) console.error(`${f} has version ${v}, tag is ${tag}`);
  process.exit(1);
}

const sha = crypto.createHash("sha256").update(fs.readFileSync(bundle)).digest("hex");
const mcpb = server.packages.find((p) => p.registryType === "mcpb");
mcpb.identifier = `https://github.com/${repo}/releases/download/${tag}/${path.basename(bundle)}`;
mcpb.fileSha256 = sha;
fs.writeFileSync(path.join(root, "server.json"), JSON.stringify(server, null, 2) + "\n");
console.log(`${path.basename(bundle)} sha256 ${sha}`);
