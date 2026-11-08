import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { expect } from "bun:test"
import { Effect, FileSystem, Layer } from "effect"
import path from "node:path"
import { ForkUpdater } from "../src/services/fork-updater"
import { Updater } from "../src/services/updater"
import { testEffect } from "../../core/test/lib/effect"

const it = testEffect(NodeServices.layer)

// A real installer script in a temporary home that reports `latest` and records every run.
function fixture(input: { latest: string; installed: boolean }) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "vysus-updater-" })
    const home = path.join(root, "home")
    const runs = path.join(root, "runs")
    const installer = path.join(home, ".vysus", "libexec", "install")
    const binary = path.join(home, ".vysus", "bin", "vysus")
    yield* fs.makeDirectory(path.dirname(installer), { recursive: true })
    yield* fs.writeFileString(
      installer,
      [`echo "$*" >> '${runs}'`, `if [ "$1" = --print-latest ]; then echo '${input.latest}'; fi`].join("\n"),
    )
    const global = Global.make({
      home,
      data: path.join(root, "data"),
      cache: path.join(root, "cache"),
      config: path.join(root, "config"),
      state: path.join(root, "state"),
      tmp: path.join(root, "tmp"),
      bin: path.join(root, "bin"),
      log: path.join(root, "log"),
      repos: path.join(root, "repos"),
    })
    const updater = yield* Updater.Service.pipe(
      Effect.provide(ForkUpdater.layer),
      Effect.provide(
        LayerNode.compile(LayerNode.group([AppProcess.node, EffectFlock.node]), {
          replacements: [Global.node.replace(Layer.succeed(Global.Service, global))],
        }),
      ),
      Effect.provideService(Global.Service, global),
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        realPath: (file) => (input.installed && file === process.execPath ? Effect.succeed(binary) : fs.realPath(file)),
      }),
    )
    const recorded = fs.readFileString(runs).pipe(
      Effect.map((text) => text.trim().split("\n")),
      Effect.orElseSucceed(() => []),
    )
    return { updater, recorded }
  })
}

it.live("accepts only release versions of this distribution", () =>
  Effect.sync(() => {
    expect(["2.0.26-vysus.1", "v2.0.27-vysus.12"].every(ForkUpdater.isRelease)).toBe(true)
    expect(["2.0.27", "2.0.27-beta.1", "2.0.27-vysus", "2.0.27-vysus.1.2", "latest"].some(ForkUpdater.isRelease)).toBe(
      false,
    )
  }),
)

it.live("reads the latest release from the installed installer", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ latest: "2.0.27-vysus.1", installed: true })
    expect(yield* test.updater.method()).toBe("curl")
    expect(yield* test.updater.latest()).toBe("2.0.27-vysus.1")
    expect(yield* test.recorded).toEqual(["--print-latest"])
  }),
)

it.live("refuses a latest release that is not from this distribution", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ latest: "2.0.27", installed: true })
    expect(yield* test.updater.latest().pipe(Effect.flip)).toMatchObject({
      title: "The latest release is not a MyVy release",
    })
  }),
)

it.live("upgrades only through the installer and only to releases of this distribution", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ latest: "2.0.27-vysus.1", installed: true })
    for (const method of ["npm", "pnpm", "bun", "yarn", "vp", "brew"] as const) {
      const refused = { title: `MyVy does not update with ${method}` }
      expect(yield* test.updater.latest(method).pipe(Effect.flip)).toMatchObject(refused)
      expect(yield* test.updater.upgrade(method, "2.0.27-vysus.1").pipe(Effect.flip)).toMatchObject(refused)
    }
    expect(yield* test.updater.upgrade("curl", "2.0.27").pipe(Effect.flip)).toMatchObject({
      title: "2.0.27 is not a MyVy release",
    })
    expect(yield* test.recorded).toEqual([])

    yield* test.updater.upgrade("curl", "v2.0.27-vysus.1")
    expect(yield* test.recorded).toEqual(["--version 2.0.27-vysus.1 --no-modify-path --no-setup"])
  }),
)

it.live("leaves builds outside the managed install alone", () =>
  Effect.gen(function* () {
    const test = yield* fixture({ latest: "2.0.27-vysus.1", installed: false })
    expect(yield* test.updater.method()).toBeUndefined()
    expect(test.updater.removal("curl")).toBeUndefined()
  }),
)
