#!/usr/bin/env bun
// Installs vysus in a clean temporary home and PATH from a local release mirror, then exercises
// commands, an upgrade between two releases, refused upgrades, and uninstall.
//   bun vysus/script/e2e.ts --release dist/vysus/v<a> --next dist/vysus/v<b>
import { existsSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

const root = path.resolve(import.meta.dirname, "../..")
const args = parseArgs({ options: { release: { type: "string" }, next: { type: "string" } } }).values
const first = await release(args.release)
const second = await release(args.next)
const asset = `vysus-darwin-${process.arch}.tar.gz`
// Resolved so paths printed by the binary (from its resolved executable path) compare equal.
const sandbox = await realpath(await mkdtemp(path.join(os.tmpdir(), "vysus-e2e-")))
const home = path.join(sandbox, "home")
const mirror = path.join(sandbox, "mirror")
const managerLog = path.join(sandbox, "managers.log")
const failures: string[] = []

try {
  await mkdir(path.join(sandbox, "tmp"), { recursive: true })
  await mkdir(path.join(sandbox, "fakebin"), { recursive: true })
  await mkdir(home, { recursive: true })
  for (const manager of ["npm", "pnpm", "yarn", "bun", "vp", "brew"])
    await writeExecutable(path.join(sandbox, "fakebin", manager), `echo "${manager} $*" >> '${managerLog}'\nexit 1`)
  for (const item of [first, second])
    await cp(item.dir, path.join(mirror, "download", `v${item.version}`), { recursive: true })
  await publish(first.version)

  const install = sh(`cat '${path.join(root, "vysus", "install")}' | bash -s -- --no-setup`)
  check(install.code === 0 && install.out.includes(`Installed vysus ${first.version}`), "installs the latest release")
  for (const file of ["bin/vysus", "libexec/install", "LICENSE", "NOTICE.md"])
    check(existsSync(path.join(home, ".vysus", file)), `installs ~/.vysus/${file}`)
  check((await readFile(path.join(home, ".vysus", "LICENSE"), "utf8")).includes("MIT License"), "ships the MIT license")
  const zshrc = await readFile(path.join(home, ".zshrc"), "utf8")
  check(zshrc.includes(`# vysus\nexport PATH=${home}/.vysus/bin:$PATH`), "adds ~/.vysus/bin to PATH in ~/.zshrc")
  check(install.out.includes("vysus auth login abliteration-ai"), "explains Abliteration.ai setup")
  check(
    !install.out.includes("ABLIT_KEY=") && !existsSync(path.join(home, ".config", "vysus")),
    "stores no key or config",
  )

  check(shell("vysus --version").out.trim() === `vysus v${first.version}`, "runs from PATH after install")
  check(shell("vysus --help").out.includes("MyVy command line interface"), "shows MyVy help")
  check(shell("vysus debug paths").out.includes(path.join(home, ".local", "share", "vysus")), "keeps data in vysus")

  await publish(second.version)
  const upgrade = shell("vysus upgrade")
  check(upgrade.code === 0, "upgrades to the next release")
  check(shell("vysus --version").out.trim() === `vysus v${second.version}`, `runs ${second.version} after upgrade`)
  check((await readFile(path.join(home, ".zshrc"), "utf8")) === zshrc, "upgrade leaves the shell config alone")

  const npm = shell("vysus upgrade --method npm")
  check(npm.code !== 0 && npm.out.includes("MyVy does not update with npm"), "refuses --method npm")
  const pinned = shell("vysus upgrade 2.0.27")
  check(pinned.code !== 0 && pinned.out.includes("2.0.27 is not a MyVy release"), "refuses an upstream version")

  const impostor = await fakeRelease("9.9.9-vysus.1", "echo 'opencode v9.9.9'")
  await publish(impostor)
  const replaced = shell("vysus upgrade")
  check(replaced.code !== 0 && replaced.out.includes("refusing to install"), "refuses a binary that is not vysus")
  const tampered = await fakeRelease("9.9.9-vysus.2", "echo 'vysus v9.9.9-vysus.2'", "0".repeat(64))
  await publish(tampered)
  const corrupt = shell("vysus upgrade")
  check(corrupt.code !== 0 && corrupt.out.includes("checksum verification failed"), "refuses a checksum mismatch")
  await writeFile(path.join(mirror, "latest", "download", "release.json"), JSON.stringify({ version: "9.9.9" }))
  const upstream = shell("vysus upgrade")
  check(upstream.code !== 0 && upstream.out.includes("is not a vysus release"), "refuses an upstream latest release")
  check(shell("vysus --version").out.trim() === `vysus v${second.version}`, "refused upgrades keep the installed build")

  const uninstall = shell("vysus uninstall --force")
  check(
    uninstall.code === 0 && uninstall.out.includes(`rm '${home}/.vysus/bin/vysus'`),
    "uninstall points at the binary",
  )
  check(!(await readFile(path.join(home, ".zshrc"), "utf8")).includes(".vysus/bin"), "uninstall cleans the PATH entry")
  check(!existsSync(path.join(managerLog)), "no package manager is invoked")
  for (const dir of [
    ".local/share/opencode",
    ".local/state/opencode",
    ".config/opencode",
    ".cache/opencode",
    ".opencode",
  ])
    check(!existsSync(path.join(home, dir)), `nothing is written to ~/${dir}`)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

if (failures.length) {
  console.error(`e2e failed:\n${failures.map((failure) => `  - ${failure}`).join("\n")}`)
  process.exit(1)
}
console.log("e2e passed")

async function release(dir: string | undefined) {
  if (!dir) throw new Error("Pass --release and --next release directories from vysus/script/release.ts")
  const resolved = path.resolve(dir)
  const metadata: { version: string } = await Bun.file(path.join(resolved, "release.json")).json()
  return { dir: resolved, version: metadata.version }
}

async function publish(version: string) {
  await mkdir(path.join(mirror, "latest", "download"), { recursive: true })
  await writeFile(path.join(mirror, "latest", "download", "release.json"), JSON.stringify({ version }))
}

// A release whose archive holds `script` as its binary, with a correct checksum unless `checksum` is given.
async function fakeRelease(version: string, script: string, checksum?: string) {
  const stage = path.join(sandbox, "stage", version)
  const dir = path.join(mirror, "download", `v${version}`)
  await mkdir(path.join(stage, "bin"), { recursive: true })
  await mkdir(path.join(stage, "libexec"), { recursive: true })
  await mkdir(dir, { recursive: true })
  await writeExecutable(path.join(stage, "bin", "vysus"), script)
  await cp(path.join(root, "vysus", "install"), path.join(stage, "libexec", "install"))
  Bun.spawnSync(["tar", "-czf", path.join(dir, asset), "-C", stage, "bin", "libexec"], {
    env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
  })
  const digest = new Bun.CryptoHasher("sha256").update(await Bun.file(path.join(dir, asset)).bytes()).digest("hex")
  await writeFile(path.join(dir, "SHA256SUMS"), `${checksum ?? digest}  ${asset}\n`)
  return version
}

// Commands run through a login-free zsh that only knows the PATH entry the installer wrote.
function shell(command: string) {
  return sh(`source ~/.zshrc; ${command}`)
}

function sh(command: string) {
  const result = Bun.spawnSync(["/bin/zsh", "-f", "-c", command], {
    cwd: home,
    stdin: "ignore",
    env: {
      HOME: home,
      PATH: `${path.join(sandbox, "fakebin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
      TMPDIR: path.join(sandbox, "tmp"),
      SHELL: "/bin/zsh",
      TERM: "dumb",
      NO_COLOR: "1",
      VYSUS_RELEASES_URL: `file://${mirror}`,
    },
  })
  return { code: result.exitCode, out: result.stdout.toString() + result.stderr.toString() }
}

function check(condition: boolean, message: string) {
  console.log(`${condition ? "ok  " : "FAIL"} ${message}`)
  if (!condition) failures.push(message)
}

async function writeExecutable(file: string, body: string) {
  await writeFile(file, `#!/bin/sh\n${body}\n`)
  await chmod(file, 0o755)
}
