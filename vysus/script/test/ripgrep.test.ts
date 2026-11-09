import { afterAll, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

const script = path.join(import.meta.dirname, "..", "ripgrep.ts")
const sandboxes: string[] = []
afterAll(() => Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true }))))

// Serves any ripgrep release the way GitHub does: an archive holding <name>/rg, and a sha256sum line for it. With
// FAKE_CURL_TAMPER set, the archive changes after its checksum was published.
const curl = `#!/bin/sh
for url in "$@"; do
  case "$url" in https://*) ;; *) continue ;; esac
  echo "$url" >>"$FAKE_CURL_LOG"
  file="$(basename "$url")"
  case "$file" in
    *.tar.gz)
      name="\${file%.tar.gz}"
      mkdir -p "$FAKE_CURL_WORK/$name"
      printf '#!/bin/sh\\necho "fake %s"\\n' "$name" >"$FAKE_CURL_WORK/$name/rg"
      chmod +x "$FAKE_CURL_WORK/$name/rg"
      tar -czf "$file" -C "$FAKE_CURL_WORK" "$name" ;;
    *.sha256)
      shasum -a 256 "\${file%.sha256}" >"$file"
      if [ -n "$FAKE_CURL_TAMPER" ]; then echo tampered >>"\${file%.sha256}"; fi ;;
  esac
done
`

async function install(extra: Record<string, string> = {}) {
  const sandbox = await mkdtemp(path.join(tmpdir(), "vysus-ripgrep-"))
  sandboxes.push(sandbox)
  await mkdir(path.join(sandbox, "fake"))
  await mkdir(path.join(sandbox, "work"))
  await Bun.write(path.join(sandbox, "fake", "curl"), curl)
  await chmod(path.join(sandbox, "fake", "curl"), 0o755)
  const dir = path.join(sandbox, "bin")
  const result = Bun.spawnSync(["bun", script, dir], {
    env: {
      ...process.env,
      PATH: `${path.join(sandbox, "fake")}${path.delimiter}${process.env.PATH}`,
      FAKE_CURL_LOG: path.join(sandbox, "urls"),
      FAKE_CURL_WORK: path.join(sandbox, "work"),
      ...extra,
    },
  })
  return { code: result.exitCode, dir, urls: (await Bun.file(path.join(sandbox, "urls")).text()).trim().split("\n") }
}

test("installs the ripgrep build core pins for this platform after checking its published checksum", async () => {
  const result = await install()
  expect(result.code).toBe(0)
  const archive = result.urls[0] ?? ""
  expect(archive).toMatch(
    /^https:\/\/github\.com\/BurntSushi\/ripgrep\/releases\/download\/(\d+\.\d+\.\d+)\/ripgrep-\1-[\w-]+\.tar\.gz$/,
  )
  expect(archive).toContain(`-${process.arch === "arm64" ? "aarch64" : "x86_64"}-`)
  expect(archive).toContain(process.platform === "darwin" ? "-apple-darwin." : "-linux-")
  expect(result.urls).toEqual([archive, `${archive}.sha256`])
  expect(await readdir(result.dir)).toEqual(["rg"])
  expect(Bun.spawnSync([path.join(result.dir, "rg")]).stdout.toString()).toBe(
    `fake ${path.basename(archive, ".tar.gz")}\n`,
  )
})

test("refuses a ripgrep archive that does not match its published checksum", async () => {
  const result = await install({ FAKE_CURL_TAMPER: "1" })
  expect(result.code).not.toBe(0)
  expect(await readdir(result.dir)).not.toContain("rg")
})
