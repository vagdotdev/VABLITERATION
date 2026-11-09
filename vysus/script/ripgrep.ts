#!/usr/bin/env bun
// Installs <dir>/rg: the ripgrep build core downloads when no rg is on PATH, as pinned for this platform in
// packages/core/src/ripgrep/binary.ts, after checking it against the SHA-256 checksum ripgrep publishes with it.
// Core's tests refuse network access, so validation puts <dir> first on their PATH instead of letting core download it.
//   bun vysus/script/ripgrep.ts <dir>
import { $ } from "bun"
import { mkdir } from "node:fs/promises"
import path from "node:path"

const dir = process.argv[2]
if (!dir) throw new Error("Usage: bun vysus/script/ripgrep.ts <dir>")
const source = await Bun.file(path.join(import.meta.dirname, "../../packages/core/src/ripgrep/binary.ts")).text()
const key = `${process.arch}-${process.platform}`
const version = source.match(/const VERSION = "(\d+\.\d+\.\d+)"/)?.[1]
const platform = source.match(new RegExp(`"${key}": \\{ platform: "([\\w-]+)", extension: "tar\\.gz" \\}`))?.[1]
if (!version || !platform)
  throw new Error(`packages/core/src/ripgrep/binary.ts no longer shows which ripgrep core downloads on ${key}`)
const name = `ripgrep-${version}-${platform}`
const url = `https://github.com/BurntSushi/ripgrep/releases/download/${version}/${name}.tar.gz`

await mkdir(dir, { recursive: true })
$.cwd(dir)
await $`curl -fsSL --retry 3 --remote-name-all ${url} ${url}.sha256`
await $`shasum -a 256 -c ${name}.tar.gz.sha256`
await $`tar -xzf ${name}.tar.gz --strip-components 1 ${name}/rg`
await $`rm ${name}.tar.gz ${name}.tar.gz.sha256`
