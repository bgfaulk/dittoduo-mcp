# DittoDuo MCP bridge

Lets MCP hosts (Claude Desktop, Claude Code, Cursor and others) use the MCP server
that ships inside the [DittoDuo](https://dittoduo.io) Mac app.

This repo holds a launcher, not a server. `server/launcher.js` is about 120 lines of
Node with no dependencies. It finds the helper inside the installed app, checks the
helper's code signature, and runs it. MCP messages pass straight through stdin and
stdout; the launcher never reads or changes them.

The same file is the entry point of the `.mcpb` bundle and the `bin` of the npm
package `@dittoduo/mcp`.

## Requirements

- macOS with DittoDuo installed in `/Applications` or `~/Applications`.
- Tool calls need a DittoDuo Pro license and MCP access turned on in DittoDuo
  Settings → MCP. Without them the helper still starts and lists its tools, but it
  answers every call with a short refusal.

## Tools

These come from the helper, not from this repo.

| Tool | What it does |
| --- | --- |
| `list_clips` | Recent clips, newest first: metadata and a short redacted preview, never the full text. |
| `get_clip` | One recent clip by id: metadata by default, optionally the redacted text. |

## Install

**Claude Desktop (recommended):** download `dittoduo.mcpb` from the
[latest release](https://github.com/bgfaulk/dittoduo-mcp/releases/latest), check its
SHA-256 against the release notes, and open it.

**npm:** use a pinned version rather than whatever is latest:

```json
{
  "mcpServers": {
    "dittoduo": { "command": "npx", "args": ["-y", "@dittoduo/mcp@1.0.0"] }
  }
}
```

**No bridge at all:** DittoDuo Settings → MCP shows the helper's absolute path. Any
host can run that path directly; this bridge only exists so hosts can discover and
install DittoDuo.

## What the launcher does

1. **Finds the helper.** It tries, in order:
   - `$DITTODUO_HELPER`, which must be an absolute path (for an app installed somewhere unusual);
   - `/Applications/DittoDuo.app/Contents/Helpers/DittoDuoMCP`;
   - `~/Applications/DittoDuo.app/Contents/Helpers/DittoDuoMCP`.
2. **Checks the signature** with `/usr/bin/codesign`:

   ```
   codesign --verify --strict \
     -R='identifier "com.501coding.dittoduo.mcp" and anchor apple generic and certificate leaf[subject.OU] = "473BT83344"' \
     <helper>
   ```

   So the helper must be signed with a Developer ID certificate issued by Apple to
   team `473BT83344`, under the identifier `com.501coding.dittoduo.mcp`. A helper
   picked through `$DITTODUO_HELPER` gets the same check.
3. **Runs it** with `spawn(helper, [], { stdio: "inherit" })`. The helper gets the
   launcher's stdin, stdout and stderr. SIGTERM, SIGINT and SIGHUP go to the helper.
   The launcher exits with the helper's exit code, or by the same signal that ended it.

If something is wrong it writes one line to stderr and exits 1:

- `dittoduo-mcp: DittoDuo isn't installed. Get it at https://dittoduo.io/download`
- `dittoduo-mcp: The DittoDuo helper failed its signature check; reinstall DittoDuo.`
- `dittoduo-mcp: DITTODUO_HELPER must be an absolute path to the DittoDuoMCP helper.`

## Security notes

- **No dependencies.** The npm package contains `server/launcher.js`, `package.json`,
  `README.md` and `LICENSE`. The bundle contains the launcher, `manifest.json` and `LICENSE`.
- **Published from CI.** Releases are built by `.github/workflows/release.yml` from a
  tag. npm packages are published through trusted publishing (OIDC) with a provenance
  attestation, so `npm view @dittoduo/mcp` shows which commit and workflow built them.
- **Check-then-run gap.** There is a short window between `codesign --verify` and
  `spawn`. Something able to swap the helper in that window could already change
  `/Applications/DittoDuo.app`, which needs admin rights for a normal install. This is
  accepted.
- **No network.** The launcher makes no network calls. The helper reads DittoDuo's
  local store; it does not talk to any server.

## Development

```sh
node --test                                         # unit + stdio pass-through tests
npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json
npx -y @anthropic-ai/mcpb@2.1.2 pack . dittoduo.mcpb  # files listed in .mcpbignore stay out
```

The tests replace `codesign` and `spawn` with fakes, except two: one runs the real
launcher against a stub helper and checks that stdin reaches stdout byte for byte,
and one (macOS only) checks that the real `codesign` rejects an unsigned helper.

## Releasing

1. Bump `version` in `package.json`, `manifest.json` and `server.json` (both the
   top-level `version` and the npm package's `version`). Commit.
2. Tag and push: `git tag v1.0.1 && git push origin v1.0.1`.
3. The `release` workflow then:
   - runs the tests and `mcpb validate`;
   - packs `dittoduo.mcpb`;
   - checks the tag matches every version field, and writes the release URL and the
     bundle's SHA-256 into `server.json` (`scripts/set-release.js`);
   - validates `server.json` against its published schema;
   - creates the GitHub release with `dittoduo.mcpb` and `server.json` attached;
   - runs `npm publish --provenance --access public`.

One-time npm setup: create the `dittoduo` org with 2FA required, publish the first
version, then add a trusted publisher on npmjs.com for this repository, workflow
`release.yml`, environment `release`. After that, set the package to disallow token
publishing.

### MCP Registry (run locally)

The Registry entry is `io.dittoduo/clipboard`. The `io.dittoduo` namespace is proven
by a DNS TXT record on the apex of `dittoduo.io`. Publishing is a manual step after
the release workflow finishes:

1. Once, create a key pair and the TXT record (Ed25519 needs OpenSSL 3; macOS's
   LibreSSL lacks it, so use `brew install openssl@3`). Keep `key.pem` out of this repo.

   ```sh
   OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl
   $OPENSSL genpkey -algorithm Ed25519 -out key.pem
   PUBLIC_KEY="$($OPENSSL pkey -in key.pem -pubout -outform DER | tail -c 32 | base64)"
   echo "dittoduo.io. IN TXT \"v=MCPv1; k=ed25519; p=${PUBLIC_KEY}\""
   ```

   Add that record to the **apex** `dittoduo.io` (not a subdomain such as
   `_mcp-auth.dittoduo.io`). The record value is:

   ```
   v=MCPv1; k=ed25519; p=<base64 of the 32-byte Ed25519 public key>
   ```

   When rotating keys, remove the old record; a stale one makes verification fail.
2. Each release, download that release's `server.json` (it has the real SHA-256), then:

   ```sh
   brew install mcp-publisher
   PRIVATE_KEY="$($OPENSSL pkey -in key.pem -noout -text | grep -A3 "priv:" | tail -n +2 | tr -d ' :\n')"
   mcp-publisher login dns --domain dittoduo.io --private-key "$PRIVATE_KEY"
   mcp-publisher publish
   curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.dittoduo/clipboard"
   ```

The Registry checks npm ownership through `"mcpName": "io.dittoduo/clipboard"` in
`package.json`. For the `.mcpb` package it requires a GitHub or GitLab release URL that
contains "mcp", plus `fileSha256`.

The Registry is in preview and may reset its data; re-publishing is the same command.

## References

Checked on 2026-10-06.

- MCPB manifest spec: https://github.com/modelcontextprotocol/mcpb/blob/main/MANIFEST.md
- MCPB manifest schema (v0.3, the `latest` schema): https://github.com/modelcontextprotocol/mcpb/tree/main/schemas
- MCPB CLI: https://github.com/modelcontextprotocol/mcpb/blob/main/CLI.md
- server.json schema: https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
- server.json format: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- Official Registry requirements: https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/official-registry-requirements.md
- Package types and ownership checks: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx
- Registry authentication (DNS): https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/authentication.mdx
- Registry quickstart: https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx
- npm provenance: https://docs.npmjs.com/generating-provenance-statements
- npm trusted publishing: https://docs.npmjs.com/trusted-publishers

## License

MIT. See [LICENSE](LICENSE).
