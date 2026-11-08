#!/usr/bin/env bun
// Merges upstream OpenCode into a new integration branch and validates the result. It never changes v2,
// tags, or publishes: a person reviews the branch, merges it, and then builds a release.
//   bun vysus/script/sync-upstream.ts [--remote <url>] [--ref v2]
//   bun vysus/script/sync-upstream.ts --validate   (after resolving conflicts and committing the merge)
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
    validate: { type: "boolean", default: false },
  },
}).values
// GitHub runs every file in .github/workflows. Only these stay there; upstream's workflows and the actions
// only they use live, inert, in vysus/upstream-github.
const workflows = ["vysus-release.yml", "vysus-upstream-sync.yml"]
const actions = ["setup-bun"]

if ((await $`git status --porcelain`.text()).trim()) throw new Error("Commit or stash local changes first")
if (!args.validate) await merge()
await validate()
console.log("\nValidated. Open a pull request from this branch into v2, and build a release only after it merges.")

async function merge() {
  await $`git fetch --no-tags ${args.remote} ${args.ref}`
  const upstream = (await $`git rev-parse FETCH_HEAD`.text()).trim()
  if ((await $`git merge-base --is-ancestor ${upstream} HEAD`.nothrow()).exitCode === 0) {
    console.log(`Already contains upstream ${args.ref} ${upstream.slice(0, 10)}`)
    process.exit(0)
  }
  const branch = `sync-${upstream.slice(0, 10)}`
  await $`git switch -c ${branch}`
  await $`git merge --no-ff --no-commit ${upstream}`.nothrow()
  await park(upstream)
  const conflicts = (await $`git diff --name-only --diff-filter=U`.text()).trim()
  if (!conflicts) {
    await $`git commit -q -m ${`chore: merge upstream ${args.ref} ${upstream.slice(0, 10)}`}`
    return
  }
  console.error(`\nMerging upstream stopped on conflicts in ${branch}:\n${conflicts}\n
Workflow files are already resolved. Resolve the rest so the vysus changes listed in vysus/README.md survive,
commit the merge, then run:
  bun vysus/script/sync-upstream.ts --validate`)
  process.exit(2)
}

// Replaces upstream's .github/workflows and .github/actions with an inert copy, then restores the vysus workflows
// and the upstream actions they use. This also resolves any merge conflict in those paths.
async function park(upstream: string) {
  await $`git rm -r -q -f --ignore-unmatch vysus/upstream-github .github/workflows .github/actions`
  await $`git checkout ${upstream} -- .github/workflows .github/actions`
  await mkdir(path.join(root, "vysus", "upstream-github"), { recursive: true })
  await $`git mv .github/workflows vysus/upstream-github/workflows`
  await $`git mv .github/actions vysus/upstream-github/actions`
  await $`git checkout HEAD -- ${workflows.map((name) => `.github/workflows/${name}`)}`
  await mkdir(path.join(root, ".github", "actions"), { recursive: true })
  for (const name of actions) await $`git mv vysus/upstream-github/actions/${name} .github/actions/${name}`
}

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
  try {
    await $`bun install --frozen-lockfile`
    await $`bun run check`
    await $`bun run test`.cwd(path.join(root, "packages", "core"))
    for (const name of ["util", "cli", "tui"])
      await $`bun test`.cwd(path.join(root, "packages", name)).env({
        ...process.env,
        HOME: home,
        XDG_DATA_HOME: path.join(home, "data"),
        XDG_CONFIG_HOME: path.join(home, "config"),
        XDG_STATE_HOME: path.join(home, "state"),
        XDG_CACHE_HOME: path.join(home, "cache"),
        TMPDIR: path.join(home, "tmp"),
      })
    for (const build of ["0", "1"])
      await $`bun vysus/script/release.ts --version ${version}.${build} --target ${target} --skip-web-ui --skip-install`
    await $`bun vysus/script/e2e.ts --release dist/vysus/v${version}.0 --next dist/vysus/v${version}.1`
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
