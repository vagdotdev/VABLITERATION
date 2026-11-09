import { Brand } from "@opencode/util/brand"
import { EffectFlock } from "@opencode/util/effect-flock"
import { Global } from "@opencode/util/global"
import { AppProcess } from "@opencode/util/process"
import { Duration, Effect, FileSystem, Layer, Ref } from "effect"
import { ChildProcess } from "effect/process"
import path from "node:path"
import { stripVTControlCharacters } from "node:util"
import { OPENCODE_LOCAL, OPENCODE_VERSION } from "../version"
import { Updater } from "./updater"
import { action } from "./updater-action"

const release = new RegExp(`^v?[0-9]+\\.[0-9]+\\.[0-9]+-${Brand.cli}\\.[0-9]+$`)

export function isRelease(version: string) {
  return release.test(version.trim())
}

// Package managers and the upstream installer would put upstream OpenCode in place of this build,
// so the only update path is the installer that this distribution's own releases ship.
const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const global = yield* Global.Service
  const appProcess = yield* AppProcess.Service
  const flock = yield* EffectFlock.Service
  const installedVersion = yield* Ref.make(OPENCODE_VERSION)
  const root = path.join(global.home, `.${Brand.cli}`)
  const installer = path.join(root, "libexec", "install")
  const binary = path.join(root, "bin", Brand.cli)
  const executable = yield* fs.realPath(process.execPath).pipe(Effect.orElseSucceed(() => process.execPath))
  const installed = yield* fs.realPath(binary).pipe(Effect.orElseSucceed(() => binary))
  const retry = `Fix the issue above, or reinstall ${Brand.cli} from https://github.com/${Brand.repository}. Private releases download only through the GitHub CLI: run gh auth login with an account that has access.`

  const readPolicy = Effect.fnUntraced(function* () {
    const values = yield* Effect.forEach(["config.json", "opencode.json", "opencode.jsonc"], (name) =>
      fs.readFileString(path.join(global.config, name)).pipe(
        Effect.map(Updater.decodePolicy),
        Effect.orElseSucceed(() => undefined),
      ),
    )
    return values.findLast((value) => value !== undefined) ?? "auto"
  })

  const runInstaller = (title: string, args: string[], timeout: Duration.Input) =>
    appProcess
      .run(ChildProcess.make("bash", [installer, ...args]), {
        timeout,
        maxOutputBytes: 100_000,
        maxErrorBytes: 100_000,
      })
      .pipe(
        Effect.mapError(
          (cause) => new Updater.UpgradeError({ title, detail: tail(cause.stderr ?? cause.message), retry }, { cause }),
        ),
        Effect.flatMap((result) =>
          result.exitCode === 0
            ? Effect.succeed(result.stdout.toString("utf8").trim())
            : Effect.fail(
                new Updater.UpgradeError({
                  title,
                  detail: tail(result.stderr.toString("utf8") || result.stdout.toString("utf8")),
                  command: ["bash", installer, ...args].join(" "),
                  retry,
                }),
              ),
        ),
      )

  const method = () => Effect.succeed(executable === installed ? ("curl" as const) : undefined)

  const latest = (selected?: Updater.Method) =>
    (selected && selected !== "curl"
      ? Effect.fail(refuseMethod(selected))
      : runInstaller(`Could not check for ${Brand.product} updates`, ["--print-latest"], "1 minute")
    ).pipe(
      Effect.flatMap((version) =>
        isRelease(version)
          ? Effect.succeed(version.replace(/^v/, ""))
          : Effect.fail(
              new Updater.UpgradeError({
                title: `The latest release is not a ${Brand.product} release`,
                detail: `The installer reported "${version}", which is not versioned like 2.0.26-${Brand.cli}.1.`,
                retry,
              }),
            ),
      ),
    )

  const upgrade = Effect.fnUntraced(function* (method: Updater.Method, input: string) {
    const version = input.trim().replace(/^v/, "")
    if (method !== "curl") return yield* Effect.fail(refuseMethod(method))
    if (!isRelease(version))
      return yield* Effect.fail(
        new Updater.UpgradeError({
          title: `${version} is not a ${Brand.product} release`,
          detail: `${Brand.product} releases are versioned like 2.0.26-${Brand.cli}.1. Other versions are upstream OpenCode builds and would replace ${Brand.product}.`,
          retry: `Run ${Brand.cli} upgrade without a version to install the latest ${Brand.product} release.`,
        }),
      )
    yield* Effect.scoped(
      flock
        .acquire("cli-upgrade", undefined, { timeoutMs: Duration.toMillis("15 minutes") })
        .pipe(
          Effect.andThen(
            runInstaller(
              `The ${Brand.product} installer failed`,
              ["--version", version, "--no-modify-path", "--no-setup"],
              "10 minutes",
            ),
          ),
        ),
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof Updater.UpgradeError
          ? cause
          : new Updater.UpgradeError({
              title: `Could not start the ${Brand.product} upgrade`,
              detail: cause.message,
              retry,
            }),
      ),
    )
  })

  const inspect = Effect.fnUntraced(function* () {
    if (OPENCODE_LOCAL || ["1", "true"].includes(process.env.OPENCODE_DISABLE_AUTOUPDATE?.toLowerCase() ?? ""))
      return undefined
    const policy = yield* readPolicy()
    if (policy === "disable") return undefined
    const version = yield* latest()
    if (action(yield* Ref.get(installedVersion), version, policy) === "none") return undefined
    return { policy, version }
  })

  const install = Effect.fnUntraced(function* (version: string) {
    const detected = yield* method()
    if (!detected) return false
    yield* upgrade(detected, version)
    yield* Ref.set(installedVersion, version)
    return true
  })

  const apply = Effect.fn("cli.updater.apply")(function* (version: string) {
    if (!(yield* install(version))) return yield* Effect.fail(new Error("Installation method not found"))
  })

  const check = Effect.fn("cli.updater.check")(function* () {
    if (OPENCODE_LOCAL)
      return {
        type: "unavailable" as const,
        message: `This build runs from a source checkout. Use an installed ${Brand.product} release to check for updates.`,
      }
    const version = yield* latest()
    const current = yield* Ref.get(installedVersion)
    if (action(current, version, "auto") === "none") {
      // An earlier check may have installed the update while this client is still running.
      return action(OPENCODE_VERSION, current, "auto") === "none"
        ? undefined
        : { type: "installed" as const, version: current }
    }
    return { type: "available" as const, version }
  })

  const run = Effect.fn("cli.updater.run")(
    function* (onInstall: (version: string) => void = () => {}) {
      const result = yield* inspect()
      if (!result) return undefined
      if (result.policy === "notify") return { type: "available" as const, version: result.version }
      onInstall(result.version)
      if (!(yield* install(result.version))) return yield* Effect.fail(new Error("Installation method not found"))
      return { type: "installed" as const, version: result.version }
    },
    Effect.catch((error) => Effect.logWarning("update check failed", { error }).pipe(Effect.as(undefined))),
  )

  return Updater.Service.of({ run, check, apply, method, latest, upgrade, removal: () => undefined })
})

function refuseMethod(method: Updater.Method) {
  return new Updater.UpgradeError({
    title: `${Brand.product} does not update with ${method}`,
    detail: `${method} installs upstream OpenCode, which would replace ${Brand.product}. Updates come only from ${Brand.repository} releases.`,
    retry: `Run ${Brand.cli} upgrade without --method.`,
  })
}

function tail(output: string) {
  return (
    stripVTControlCharacters(output).trim().split("\n").slice(-12).join("\n") || "The installer exited without output."
  )
}

export const layer = Layer.effect(Updater.Service, make)

export * as ForkUpdater from "./fork-updater"
