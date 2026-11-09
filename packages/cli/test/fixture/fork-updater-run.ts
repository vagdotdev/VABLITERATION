import { NodeServices } from "@effect/platform-node"
import { EffectFlock } from "@opencode/util/effect-flock"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Effect, FileSystem, Layer } from "effect"
import path from "node:path"
import { ForkUpdater } from "../../src/services/fork-updater"
import { Updater } from "../../src/services/updater"

// Runs the automatic update check of a build installed as ~/.vysus/bin/vysus and prints its outcome.
// fork-updater-run.test.ts defines OPENCODE_CHANNEL and OPENCODE_VERSION, because source runs never check,
// and sets HOME and the XDG directories to a scratch home.
const global = Global.make()
const binary = path.join(global.home, ".vysus", "bin", "vysus")

await Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
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
      realPath: (file) => (file === process.execPath ? Effect.succeed(binary) : fs.realPath(file)),
    }),
  )
  const installing: string[] = []
  const result = yield* updater.run((version) => installing.push(version))
  console.log(`RESULT ${JSON.stringify({ installing, result })}`)
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise)
