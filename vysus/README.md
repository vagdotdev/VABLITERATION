# vysus (MyVy)

vysus is MyVy's personal distribution of [OpenCode](https://github.com/anomalyco/opencode) v2 for macOS. It is
OpenCode with its own executable name, terminal branding, global data directory, and update channel. OpenCode is
MIT licensed; `LICENSE` and `vysus/NOTICE.md` ship with every release and are installed to `~/.vysus`.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/vagdotdev/VABLITERATION/v2/vysus/install | bash
```

Pass options after `bash -s --`, for example `| bash -s -- --version 2.0.26-vysus.1 --no-modify-path`. The installer
downloads with `curl`, or with the [GitHub CLI](https://cli.github.com) when it is signed in. The installer:

- downloads `vysus-darwin-<arch>.tar.gz` for the latest published release (or `--version 2.0.26-vysus.1`),
- checks it against the release's `SHA256SUMS`,
- runs the downloaded binary in a scratch home and refuses it unless it reports `vysus v<that version>`,
- installs `~/.vysus/bin/vysus`, `~/.vysus/libexec/install` (used for updates), `LICENSE`, and `NOTICE.md`,
- adds `~/.vysus/bin` to `PATH` in your shell startup file under a `# vysus` comment (skip with `--no-modify-path`).

To install a local build instead: `bash vysus/install --binary packages/cli/dist/cli-darwin-arm64/bin/vysus`.

## Abliteration.ai

vysus includes the Abliteration.ai provider (`abliteration-ai`, OpenAI-compatible, `https://api.abliteration.ai/v1`).
In an interactive install the installer offers to:

1. write `~/.config/vysus/opencode.json` with `"model": "abliteration-ai/abliterated-model"`, if that file does not
   exist yet, and
2. run `vysus auth login abliteration-ai`, which asks for your API key with hidden input and stores it in vysus's
   own data directory.

The installer never reads, prints, or stores the key. Later, or without a terminal:

```sh
vysus auth login abliteration-ai   # hidden key prompt
export ABLIT_KEY=...                # alternative: environment variable read by the provider
```

Pick another model with `/models` inside vysus or by editing `model` in `~/.config/vysus/opencode.json`.

## What is separate from OpenCode

| Separate                                                                                                               | Shared on purpose (compatibility)               |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `vysus` executable in `~/.vysus/bin`                                                                                   | Project config `opencode.json` and `.opencode/` |
| Sessions, credentials, settings in `~/.local/share/vysus`, `~/.config/vysus`, `~/.local/state/vysus`, `~/.cache/vysus` | `OPENCODE_*` environment variables              |
| Background service on the `vysus` channel (own registration file and port)                                             | Plugins, the HTTP API, and provider IDs         |

Existing OpenCode sessions and credentials are not visible in vysus, and vysus never writes OpenCode's directories.

## Updates

`vysus upgrade`, the in-app update dialog, and automatic updates all run `~/.vysus/libexec/install`. They:

- refuse `--method npm|pnpm|bun|yarn|vp|brew`, because those install upstream OpenCode over vysus,
- refuse versions that are not `X.Y.Z-vysus.N`, including when the latest release reports one,
- only see published GitHub releases; drafts are invisible until someone publishes them,
- rely on the installer's checksum and identity checks before replacing the binary.

Builds outside `~/.vysus/bin` (for example `bun run dev`) never update themselves. Set `"update": "disable"`,
`"notify"` (default), or `"auto"` in `~/.config/vysus/opencode.json`, or `OPENCODE_DISABLE_AUTOUPDATE=1`.

## Maintaining the fork

vysus-specific code is kept small so upstream merges stay easy:

- `packages/util/src/brand.ts`: product name, executable name, repository.
- `packages/util/src/global.ts`: global directories use `vysus`.
- `packages/cli/src/services/fork-updater.ts` and its use in `packages/cli/src/index.ts`: the update lock.
- `packages/cli/script/build.ts`: binary and command name.
- `packages/tui/src/logo.ts` and `packages/tui/src/component/logo.tsx`: home wordmark, narrow-terminal mark, and the
  "MyVy confidential" subtitle.
- Branding strings in the CLI and TUI (titles, continue hints, update and uninstall text) and their tests.
- `vysus/` and `.github/workflows/vysus-*.yml`.

### Upstream workflows

GitHub runs every file in `.github/workflows`, so only the two `vysus-*.yml` workflows and the `setup-bun` action they
use stay in `.github/`. Upstream's workflows, and the `setup-git-committer` action only they use, are kept as an inert
copy in `vysus/upstream-github/`. Every sync replaces that copy with upstream's current files and restores the vysus
workflows, which also resolves merge conflicts in those paths, so new or changed upstream workflows never become active.
Validation fails if anything else appears in `.github/workflows`.

### Upstream sync

```sh
bun vysus/script/sync-upstream.ts
```

The script fetches upstream `v2`, creates a `sync-<upstream sha>` branch, and merges. On conflicts it stops, lists
the files, and leaves the merge for you: keep the vysus behavior from the list above, commit, and run
`bun vysus/script/sync-upstream.ts --validate`. Validation runs `bun run check`, the `core` suite, the `util`, `cli`,
and `tui` suites in a scratch home, two release builds with `vysus/script/verify.ts`, and the installer end-to-end
test. Nothing is merged into `v2` or released automatically. The `vysus upstream sync` workflow runs the same script
weekly and opens a pull request when validation passes.

Upstream commits change workflow files, and GitHub rejects pushes of those made with the default workflow token. Add
a fine-grained token for this repository with read and write access to Contents, Pull requests, and Workflows as the
`VYSUS_SYNC_TOKEN` secret. The workflow uses it only for the final push and pull request; validation runs without
stored credentials.

### Releases

Release assets are built only from committed source. `release.ts` refuses uncommitted changes; a local
`--allow-dirty` test build records `<commit>-dirty` in `release.json` and must not be published.

1. Merge the validated sync branch. Release versions are `<root package.json version>-vysus.<n>`.
2. Run the `vysus release` workflow with that version, or locally on a clean checkout:
   `bun vysus/script/release.ts --version 2.0.26-vysus.1` (both macOS architectures; verifying `darwin-x64` on Apple
   silicon needs Rosetta).
3. The workflow attaches `vysus-darwin-arm64.tar.gz`, `vysus-darwin-x64.tar.gz`, `SHA256SUMS`, and `release.json`
   to a draft release. Publish the draft to make it the update target.

### Checks

```sh
cd packages/cli && bun test test/fork-updater.test.ts
cd packages/tui && bun test test/component/logo.test.tsx
bun vysus/script/verify.ts <path to vysus binary> --version <version>
bun vysus/script/e2e.ts --release dist/vysus/v<older> --next dist/vysus/v<newer>
```

## Limitations

- The `vysus-*` workflows and installs from GitHub have not run yet; they were checked locally against a release
  mirror (`VYSUS_RELEASES_URL=file://...`). Only `darwin-arm64` has been built and run; `darwin-x64` has not been
  built or run, and the release workflow verifies it under Rosetta. It is Bun's default x64 build, which needs AVX2.
- Binaries carry only Bun's ad-hoc signature and are not notarized. Downloads through `curl` and `gh` are not
  quarantined, so Gatekeeper does not block them; a browser download would be.
- Internal names stay OpenCode: `OPENCODE_*` variables, `opencode.json`, `.opencode/`, and the HTTP user agent
  `opencode/vysus/<version>/cli` sent to model providers. Some deeper hints still print `opencode ...` commands (for
  example service, port, ACP, and MCP auth hints): run them as `vysus ...`. Docs links, the web UI, the crash
  screen's issue link, and OpenCode-hosted features (the model catalog refresh, Zen, sharing) still point at
  OpenCode. Set `OPENCODE_DISABLE_MODELS_FETCH=1` to stop the catalog refresh.
- The bundled model catalog lists the Abliteration.ai models known at the time of the upstream snapshot; newer models
  may need the catalog refresh or a `providers` entry in config.
- Updates move to whatever the latest published release is, even if it is older than the installed one, so
  publishing an older release is a rollback.
- `vysus uninstall` removes the cache and PATH entry and prints the command that removes the binary. `~/.vysus`
  also holds the updater script, license files, and Plan agent plans (`~/.vysus/plan`); delete it yourself.
- Upstream's npm packages, Dockerfile, Homebrew, AUR, desktop, and publish scripts are not adapted for vysus.
