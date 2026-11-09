import { expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const timeout = 30_000

test(
  "installs the latest release automatically when no update policy is set",
  async () => {
    await using sandbox = await scratch()
    await sandbox.installer("2.0.27-vysus.1")
    expect(await sandbox.autoUpdate()).toEqual({
      installing: ["2.0.27-vysus.1"],
      result: { type: "installed", version: "2.0.27-vysus.1" },
    })
    expect(await sandbox.lines("runs")).toEqual([
      "--print-latest",
      "--version 2.0.27-vysus.1 --no-modify-path --no-setup",
    ])
  },
  timeout,
)

test(
  "only reports a new release when the update policy is notify",
  async () => {
    await using sandbox = await scratch()
    await sandbox.installer("2.0.27-vysus.1")
    await sandbox.config({ update: "notify" })
    expect(await sandbox.autoUpdate()).toEqual({
      installing: [],
      result: { type: "available", version: "2.0.27-vysus.1" },
    })
    expect(await sandbox.lines("runs")).toEqual(["--print-latest"])
  },
  timeout,
)

test(
  "keeps explicit opt-outs from checking for updates",
  async () => {
    for (const optOut of [
      { config: { update: "disable" } },
      { config: { autoupdate: false } },
      { env: { OPENCODE_DISABLE_AUTOUPDATE: "1" } },
    ]) {
      await using sandbox = await scratch()
      await sandbox.installer("2.0.27-vysus.1")
      if (optOut.config) await sandbox.config(optOut.config)
      expect(await sandbox.autoUpdate(optOut.env)).toEqual({ installing: [] })
      expect(await sandbox.lines("runs")).toEqual([])
    }
  },
  timeout,
)

test(
  "does not install a latest release that is not from this distribution",
  async () => {
    await using sandbox = await scratch()
    await sandbox.installer("2.0.27")
    expect(await sandbox.autoUpdate()).toEqual({ installing: [] })
    expect(await sandbox.lines("runs")).toEqual(["--print-latest"])
  },
  timeout,
)

// Runs the real installer. gh is signed in, and curl gets 404 like anonymous requests for a private repository's
// releases do.
test.skipIf(process.platform !== "darwin")(
  "installs private releases through the signed-in GitHub CLI",
  async () => {
    await using sandbox = await scratch()
    const installer = await Bun.file(path.join(import.meta.dir, "..", "..", "..", "vysus", "install")).text()
    const asset = `vysus-darwin-${process.arch}.tar.gz`
    const release = path.join(sandbox.root, "release")
    await sandbox.write("home/.vysus/libexec/install", installer)
    await sandbox.write("stage/libexec/install", installer)
    await sandbox.write("stage/bin/vysus", "#!/bin/sh\necho 'vysus v2.0.27-vysus.1'\n")
    await mkdir(release)
    Bun.spawnSync(
      ["tar", "-czf", path.join(release, asset), "-C", path.join(sandbox.root, "stage"), "bin", "libexec"],
      {
        env: { PATH: "/usr/bin:/bin", COPYFILE_DISABLE: "1" },
      },
    )
    const digest = new Bun.CryptoHasher("sha256")
      .update(await Bun.file(path.join(release, asset)).bytes())
      .digest("hex")
    await sandbox.write("release/SHA256SUMS", `${digest}  ${asset}\n`)
    await sandbox.write(
      "bin/gh",
      [
        "#!/bin/bash",
        `echo "$*" >> '${sandbox.root}/gh.log'`,
        'case "$1 $2" in',
        '  "auth status") ;;',
        '  "release view") echo v2.0.27-vysus.1 ;;',
        `  "release download") while [ $# -gt 0 ] && [ "$1" != --dir ]; do shift; done; cp '${release}/'* "$2" ;;`,
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    )
    await sandbox.write(
      "bin/curl",
      '#!/bin/bash\necho "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n',
    )

    expect(await sandbox.autoUpdate()).toEqual({
      installing: ["2.0.27-vysus.1"],
      result: { type: "installed", version: "2.0.27-vysus.1" },
    })
    expect(await sandbox.lines("gh.log")).toEqual([
      "auth status",
      "release view --repo vagdotdev/VABLITERATION --json tagName --jq .tagName",
      "auth status",
      expect.stringContaining(
        `release download v2.0.27-vysus.1 --repo vagdotdev/VABLITERATION --pattern ${asset} --pattern SHA256SUMS --dir `,
      ),
    ])
    expect(await Bun.file(path.join(sandbox.root, "home", ".vysus", "bin", "vysus")).text()).toContain(
      "vysus v2.0.27-vysus.1",
    )
  },
  timeout,
)

// A scratch home and PATH in which a 2.0.26-vysus.1 build installed as ~/.vysus/bin/vysus runs its automatic update
// check through fixture/fork-updater-run.ts.
async function scratch() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "vysus-auto-update-")))
  const home = path.join(root, "home")
  const write = async (file: string, content: string) => {
    await Bun.write(path.join(root, file), content)
    await chmod(path.join(root, file), 0o755)
  }
  return {
    root,
    write,
    // Stands in for ~/.vysus/libexec/install: records each run and reports `latest` as the latest release.
    installer: (latest: string) =>
      write(
        "home/.vysus/libexec/install",
        `echo "$*" >> '${root}/runs'\nif [ "$1" = --print-latest ]; then echo '${latest}'; fi\n`,
      ),
    config: (value: object) => Bun.write(path.join(home, ".config", "vysus", "opencode.json"), JSON.stringify(value)),
    lines: async (file: string) =>
      (
        await Bun.file(path.join(root, file))
          .text()
          .catch(() => "")
      )
        .split("\n")
        .filter((line) => line !== ""),
    autoUpdate: async (env: Record<string, string> = {}): Promise<unknown> => {
      const child = Bun.spawn(
        [
          process.execPath,
          "--define",
          'OPENCODE_CHANNEL="vysus"',
          "--define",
          'OPENCODE_VERSION="2.0.26-vysus.1"',
          path.join(import.meta.dir, "fixture", "fork-updater-run.ts"),
        ],
        {
          cwd: path.join(import.meta.dir, ".."),
          env: {
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, ".config"),
            XDG_DATA_HOME: path.join(home, ".local", "share"),
            XDG_STATE_HOME: path.join(home, ".local", "state"),
            XDG_CACHE_HOME: path.join(home, ".cache"),
            TMPDIR: root,
            PATH: `${path.join(root, "bin")}:/usr/bin:/bin:/usr/sbin:/sbin`,
            ...env,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      const result = stdout.split("\n").find((line) => line.startsWith("RESULT "))
      if (exitCode !== 0 || !result) throw new Error(`The update check failed:\n${stdout}\n${stderr}`)
      return JSON.parse(result.slice("RESULT ".length))
    },
    [Symbol.asyncDispose]: () => rm(root, { recursive: true, force: true }),
  }
}
