# DittoDuo MCP bridge

Lets MCP hosts (Claude Desktop, Claude Code, Cursor and others) use the MCP server
that ships inside the [DittoDuo](https://dittoduo.io) Mac app.

This repo holds a launcher, not a server. `server/launcher.js` is about 200 lines of
Node with no dependencies. It finds the helper inside the installed app, checks the
helper's code signature, runs it, and checks the running process's signature again
before passing it any input. MCP messages pass straight through stdin and stdout; the
launcher never reads or changes them.

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

**npm:** not published yet (the `@dittoduo` npm scope does not exist). Once it is,
use a pinned version rather than whatever is latest:

```json
{
  "mcpServers": {
    "dittoduo": { "command": "npx", "args": ["-y", "@dittoduo/mcp@1.0.2"] }
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
     -R='identifier "com.501coding.dittoduo.mcp" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "473BT83344"' \
     <helper>
   ```

   So the helper must be signed with a **Developer ID Application** certificate
   (intermediate `1.2.840.113635.100.6.2.6`, leaf `1.2.840.113635.100.6.1.13`) issued
   by Apple to team `473BT83344`, under the identifier `com.501coding.dittoduo.mcp`.
   An Apple Development signature for the same team does not pass. A helper picked
   through `$DITTODUO_HELPER` gets the same check.
3. **Runs it** with `spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] })`, then
   **checks the running process** with the same requirement,
   `codesign --verify --strict -R=<requirement> <pid>`, before any input reaches it.
   If that fails, the helper is killed and the launcher exits with the signature
   message below.
4. **Pipes stdio.** The launcher pipes its stdin to the helper and the helper's stdout
   and stderr back, rather than letting the helper inherit them: hosts that run the
   launcher inside their own Node runtime (Claude Desktop's built-in Node) hand it
   stdin/stdout streams that are not file descriptors 0 and 1, so an inherited helper
   would never see a message. SIGTERM, SIGINT and SIGHUP go to the helper. The
   launcher exits with the helper's exit code, or by the same signal that ended it.

The launcher starts itself when it is the program being run, whether the host runs
it with `node server/launcher.js` or loads it with `import()` and `argv[1]` set to it
(Claude Desktop's built-in Node does the latter, which leaves `require.main` pointing
at the host's own script).

### Development builds

`DITTODUO_ALLOW_DEVELOPMENT_SIGNATURE=1` relaxes the requirement to any
Apple-issued certificate for team `473BT83344` (for example an Apple Development
build of DittoDuo), dropping the two Developer ID checks. Use it only to test a local
build; released DittoDuo is always Developer ID signed and notarized.

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
- **Check-then-run gap, closed.** A drag-installed `/Applications/DittoDuo.app` is
  owned by the user who installed it, and `~/Applications` is user-writable, so a
  same-user process could swap the helper between the file check and `spawn`. The
  launcher therefore checks the running process by pid after `spawn` and before
  sending it any input; the helper does nothing until its first message. What
  remains is a same-user attacker, who can already read the user's data.
- **No network.** The launcher makes no network calls. The helper reads DittoDuo's
  local store; it does not talk to any server.

## Development

```sh
node --test                                         # unit + stdio pass-through tests
npx -y @anthropic-ai/mcpb@2.1.2 validate manifest.json
npx -y @anthropic-ai/mcpb@2.1.2 pack . dittoduo.mcpb  # files listed in .mcpbignore stay out
```

The tests replace `codesign` and `spawn` with fakes, except the process-level ones:
the real launcher against a stub helper (stdin reaches stdout byte for byte, also
through host streams that are not fds 0/1, and when loaded with `import()`), and on
macOS the real `codesign` rejecting an unsigned helper both as a file and as a
running pid.

## Releasing

The workflow runs the tests and `mcpb validate` on every push to `main` and every
pull request. A `v*` tag also runs the release job.

1. Bump `version` in `package.json`, `manifest.json` and `server.json` (the top-level
   `version` and the npm package's `version`) and the pinned version in this README.
   Commit.
2. Tag and push: `git tag v1.0.2 && git push origin v1.0.2`.
3. The `release` job then:
   - packs `dittoduo.mcpb`;
   - checks the tag matches every version field and the README pin, and writes the
     release URL and the bundle's SHA-256 into `server.json` (`scripts/set-release.js`;
     with `--no-npm` it also drops the npm package from that file);
   - validates `server.json` against its published schema;
   - creates the GitHub release as a **draft** with `dittoduo.mcpb` and `server.json`;
   - runs `npm publish --provenance --access public`, only when the repository
     variable `PUBLISH_NPM` is `true`;
   - publishes the release. If any step fails, the release stays a draft.

The release job runs in the `release` environment. GitHub creates it on first use if
it is missing, but create it under Settings → Environments before the first tag:
that is where to add required reviewers (a manual approval before anything is
published) and a `v*` tag rule, and npm trusted publishing is scoped to it.

npm is deferred until the `dittoduo` npm scope exists. While `PUBLISH_NPM` is unset,
the release's `server.json` lists only the `.mcpb` package, so the Registry entry can
be published without npm. To turn npm on: create the `dittoduo` org with 2FA required,
publish the first version by hand, add a trusted publisher on npmjs.com for this
repository, workflow `release.yml`, environment `release`, set the package to
disallow token publishing, then set `PUBLISH_NPM` to `true`.

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

When the npm package is listed, the Registry checks its ownership through `"mcpName": "io.dittoduo/clipboard"` in
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
