#!/usr/bin/env bun
// Integrates upstream OpenCode with vysus/script/integrate (one single-parent commit on a sync-<sha> branch) and
// validates the result. It never changes v2, tags, or publishes: the vysus upstream sync workflow does that, and it
// does it on its own for every integration without conflicts. Use this script to resolve conflicts that stopped it.
//   bun vysus/script/sync-upstream.ts [--remote <url>] [--ref v2]
//   bun vysus/script/sync-upstream.ts --continue   (after resolving conflicts and staging the result with git add)
//   bun vysus/script/sync-upstream.ts --validate [--skip-build]
import { $ } from "bun"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"

const root = path.resolve(import.meta.dirname, "../..")
$.cwd(root)
const args = parseArgs({
  options: {
    remote: { type: "string", default: "https://github.com/anomalyco/opencode.git" },
    ref: { type: "string", default: "v2" },
    continue: { type: "boolean", default: false },
    validate: { type: "boolean", default: false },
    // The workflow builds and verifies release assets on macOS in a separate job.
    "skip-build": { type: "boolean", default: false },
  },
}).values
// GitHub runs every file in .github/workflows; vysus/script/integrate keeps upstream's inert in vysus/upstream-github.
const workflows = ["vysus-upstream-sync.yml"]

if (!args.validate) {
  const integrate = await $`bash vysus/script/integrate ${args.continue ? ["--continue"] : ["--remote", args.remote, "--ref", args.ref]}`.nothrow()
  if (integrate.exitCode !== 0) process.exit(integrate.exitCode)
  if (!integrate.stdout.toString().trim()) process.exit(0)
}
if ((await $`git status --porcelain`.text()).trim()) throw new Error("Commit or stash local changes first")
await validate()
console.log(
  "\nValidated. Push this commit to v2 with `git push origin HEAD:v2`; the vysus upstream sync workflow then builds and publishes its release.",
)

async function validate() {
  const present = (await readdir(path.join(root, ".github", "workflows"))).sort()
  if (present.join() !== workflows.join())
    throw new Error(
      `.github/workflows may only contain ${workflows.join(", ")}; move the rest to vysus/upstream-github`,
    )
  const version = `${(await Bun.file(path.join(root, "package.json")).json()).version}-vysus`
  const target = `darwin-${process.arch}`
  // Package tests use the real home directory unless told otherwise.
  const home = await mkdtemp("/tmp/vysus-sync-")
  await mkdir(path.join(home, "tmp"))
  const bin = path.join(home, "bin")
  const env = {
    ...process.env,
    // Core's tests refuse network access, so the ripgrep core would download for them must already be on PATH.
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: home,
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    TMPDIR: path.join(home, "tmp"),
  }
  try {
    await $`bun install --frozen-lockfile`
    await $`bun run check`
    await $`bun vysus/script/ripgrep.ts ${bin}`
    // A machine's first PowerShell start takes seconds, which would count against the 5 second timeout of whichever
    // core test starts it first. Later starts, also with another HOME, take a fraction of a second.
    const pwsh = process.env.SHELL_SCAN_PWSH ?? Bun.which("pwsh") ?? Bun.which("powershell")
    if (pwsh) await $`${pwsh} -NoLogo -NoProfile -NonInteractive -Command exit`.env(env)
    await $`bun run test`.cwd(path.join(root, "packages", "core")).env({ ...process.env, PATH: env.PATH })
    for (const name of ["util", "cli", "tui"]) await $`bun test`.cwd(path.join(root, "packages", name)).env(env)
    await $`bun test`.cwd(path.join(root, "vysus", "script")).env(env)
    if (args["skip-build"]) return
    for (const build of ["0", "1"])
      await $`bun vysus/script/release.ts --version ${version}.${build} --target ${target} --skip-web-ui --skip-install`
    await $`bun vysus/script/e2e.ts --release dist/vysus/v${version}.0 --next dist/vysus/v${version}.1`
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
