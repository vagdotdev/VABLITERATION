#!/usr/bin/env bun
// Checks a built vysus binary in a scratch home: identity, help branding, data isolation from
// OpenCode, and that upgrades refuse package managers and upstream versions.
//   bun vysus/script/verify.ts <binary> [--version 2.0.26-vysus.1]
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const args = parseArgs({ allowPositionals: true, options: { version: { type: "string" } } })
const binary = path.resolve(args.positionals[0] ?? "")
const expected = args.values.version
const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "vysus-verify-")))
const home = path.join(sandbox, "home")
const managed = path.join(home, ".vysus", "bin", "vysus")
const installerLog = path.join(sandbox, "installer.log")
const managerLog = path.join(sandbox, "managers.log")
const failures: string[] = []

try {
  await mkdir(path.join(sandbox, "fakebin"), { recursive: true })
  await mkdir(path.join(sandbox, "tmp"), { recursive: true })
  await mkdir(path.join(home, ".vysus", "libexec"), { recursive: true })
  for (const manager of ["npm", "pnpm", "yarn", "bun", "vp", "brew"])
    await writeExecutable(path.join(sandbox, "fakebin", manager), `echo "${manager} $*" >> '${managerLog}'\nexit 1`)
  await writeExecutable(
    path.join(home, ".vysus", "libexec", "install"),
    `echo "$*" >> '${installerLog}'\nif [ "$1" = --print-latest ]; then echo "$FAKE_LATEST"; fi`,
  )
  await mkdir(path.dirname(managed), { recursive: true })
  await cp(binary, managed)

  const version = run(binary, ["--version"]).out.trim()
  const reported = version.replace(/^vysus v/, "")
  check(/^vysus v[0-9]+\.[0-9]+\.[0-9]+-vysus\.[0-9]+$/.test(version), `--version reports "${version}"`)
  if (expected) check(reported === expected, `--version reports ${reported}, expected ${expected}`)

  const help = run(binary, ["--help"])
  check(help.code === 0 && help.out.includes("MyVy command line interface"), "--help shows the MyVy description")
  check(/\bvysus (?:<subcommand>|\[)/.test(help.out), "--help shows vysus as the command name")
  check(!help.out.includes("OpenCode command line interface"), "--help does not describe OpenCode")

  const paths = run(binary, ["debug", "paths"])
  check(paths.code === 0 && paths.out.includes(path.join(home, ".local", "share", "vysus")), "data lives in vysus")
  for (const dir of [
    ".local/share/opencode",
    ".local/state/opencode",
    ".config/opencode",
    ".cache/opencode",
    ".opencode",
  ])
    check(!existsSync(path.join(home, dir)), `nothing is written to ~/${dir}`)

  const npm = run(managed, ["upgrade", "--method", "npm", "9.9.9-vysus.1"])
  check(npm.code !== 0 && npm.out.includes("MyVy does not update with npm"), "upgrade refuses --method npm")
  const upstream = run(managed, ["upgrade", "9.9.9"])
  check(
    upstream.code !== 0 && upstream.out.includes("9.9.9 is not a MyVy release"),
    "upgrade refuses upstream versions",
  )
  const latestUpstream = run(managed, ["upgrade"], { FAKE_LATEST: "9.9.9" })
  check(
    latestUpstream.code !== 0 && latestUpstream.out.includes("The latest release is not a MyVy release"),
    "upgrade refuses an upstream latest release",
  )
  check(
    (await read(installerLog)).every((line) => line === "--print-latest"),
    "refused upgrades never install",
  )
  const release = run(managed, ["upgrade"], { FAKE_LATEST: "9.9.9-vysus.1" })
  check(
    release.code === 0 && (await read(installerLog)).includes("--version 9.9.9-vysus.1 --no-modify-path --no-setup"),
    "upgrade installs the latest release through the vysus installer",
  )
  check((await read(managerLog)).length === 0, "no package manager is invoked")
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`verify failed for ${binary}:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
  process.exit(1)
}
console.log(`verified ${binary}`)

function run(executable: string, argv: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([executable, ...argv], {
    cwd: home,
    stdin: "ignore",
    env: {
      HOME: home,
      PATH: `${path.join(sandbox, "fakebin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: path.join(sandbox, "tmp"),
      SHELL: "/bin/zsh",
      TERM: "dumb",
      NO_COLOR: "1",
      ...env,
    },
  })
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
}

function check(condition: boolean, message: string) {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`)
  if (!condition) failures.push(message)
}

async function read(file: string) {
  if (!existsSync(file)) return []
  return (await readFile(file, "utf8")).trim().split("\n")
}

async function writeExecutable(file: string, body: string) {
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
}
