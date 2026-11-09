#!/usr/bin/env bun
// Builds and verifies vysus release assets for macOS into dist/vysus/v<version>. The vysus upstream sync workflow
// runs it and publishes the assets with vysus/script/publish.
//   bun vysus/script/release.ts --version 2.0.26-vysus.1 [--target darwin-arm64] [--skip-web-ui] [--skip-install] [--allow-dirty]
import { $ } from "bun"
import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { parseArgs } from "node:util"
import { Brand } from "../../packages/util/src/brand"

const root = path.resolve(import.meta.dirname, "../..")
const args = parseArgs({
  options: {
    version: { type: "string", default: "" },
    target: { type: "string", multiple: true, default: ["darwin-arm64", "darwin-x64"] },
    "skip-web-ui": { type: "boolean", default: false },
    "skip-install": { type: "boolean", default: false },
    "allow-dirty": { type: "boolean", default: false },
  },
}).values
const upstream: string = (await Bun.file(path.join(root, "package.json")).json()).version
const version = args.version.replace(/^v/, "")
if (
  !version.startsWith(`${upstream}-${Brand.cli}.`) ||
  !/^[0-9]+$/.test(version.slice(upstream.length + Brand.cli.length + 2))
)
  throw new Error(`--version must be ${upstream}-${Brand.cli}.<n>, matching the merged upstream version ${upstream}`)
const dirty = (await $`git status --porcelain`.cwd(root).text()).trim() !== ""
if (dirty && !args["allow-dirty"])
  throw new Error("Commit changes before building a release, or pass --allow-dirty for a local test build")

const out = path.join(root, "dist", "vysus", `v${version}`)
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })
const sums: string[] = []
for (const target of args.target) {
  const build = path.join(root, "dist", "vysus", "build", target)
  const flags = [...(args["skip-web-ui"] ? ["--skip-web-ui"] : []), ...(args["skip-install"] ? ["--skip-install"] : [])]
  await $`bun run script/build.ts --target=${Brand.cli}-${target} --outdir=${build} ${flags}`
    .cwd(path.join(root, "packages", "cli"))
    .env({ ...process.env, OPENCODE_CHANNEL: Brand.cli, OPENCODE_VERSION: version })
  const stage = path.join(build, "stage")
  await mkdir(path.join(stage, "bin"), { recursive: true })
  await mkdir(path.join(stage, "libexec"), { recursive: true })
  await cp(path.join(build, `cli-${target}`, "bin", Brand.cli), path.join(stage, "bin", Brand.cli))
  await cp(path.join(root, "vysus", "install"), path.join(stage, "libexec", "install"))
  await cp(path.join(root, "LICENSE"), path.join(stage, "LICENSE"))
  await cp(path.join(root, "vysus", "NOTICE.md"), path.join(stage, "NOTICE.md"))
  await $`bun ${path.join(root, "vysus", "script", "verify.ts")} ${path.join(stage, "bin", Brand.cli)} --version ${version}`
  const asset = `${Brand.cli}-${target}.tar.gz`
  await $`tar -czf ${path.join(out, asset)} -C ${stage} bin libexec LICENSE NOTICE.md`.env({
    ...process.env,
    COPYFILE_DISABLE: "1",
  })
  sums.push(
    `${new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(out, asset)).bytes()).digest("hex")}  ${asset}`,
  )
}
await Bun.write(path.join(out, "SHA256SUMS"), sums.join("\n") + "\n")
const commit = (await $`git rev-parse HEAD`.cwd(root).text()).trim()
await Bun.write(
  path.join(out, "release.json"),
  JSON.stringify({ version, upstream, commit: dirty ? `${commit}-dirty` : commit }, null, 2) + "\n",
)
console.log(
  dirty
    ? `\nTest assets in ${path.relative(root, out)} were built from uncommitted changes. Do not publish them.`
    : `\nRelease assets in ${path.relative(root, out)}. Releases of ${Brand.repository} are published by its vysus upstream sync workflow.`,
)
