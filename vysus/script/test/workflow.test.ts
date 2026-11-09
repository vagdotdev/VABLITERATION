import { expect, test } from "bun:test"
import { readdir } from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "../../..")
const file = path.join(root, ".github", "workflows", "vysus-upstream-sync.yml")
const text = await Bun.file(file).text()
const workflow = Bun.YAML.parse(text) as Workflow

type Step = {
  name: string
  uses?: string
  run?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
  "continue-on-error"?: unknown
}
type Job = {
  "runs-on": string
  needs?: string | string[]
  if?: string
  permissions: Record<string, string>
  env?: Record<string, string>
  steps: Step[]
}
type Triggers = { schedule: { cron: string }[] }
type Workflow = {
  // GitHub reads the unquoted `on` key as "on". Bun.YAML reads it as "on" or, in versions that follow YAML 1.1, as the
  // boolean true.
  on?: Triggers
  true?: Triggers
  permissions: Record<string, string>
  concurrency: { group: string; "cancel-in-progress": boolean }
  jobs: Record<string, Job>
}

test("only the vysus workflow is active, and every script keeps it", async () => {
  const active = (await readdir(path.join(root, ".github", "workflows"))).sort()
  expect(active).toEqual(["vysus-upstream-sync.yml"])
  const integrate = await Bun.file(path.join(root, "vysus", "script", "integrate")).text()
  expect(integrate.match(/^workflows=\((.*)\)$/m)?.[1].split(" ")).toEqual(active)
  const sync = await Bun.file(path.join(root, "vysus", "script", "sync-upstream.ts")).text()
  expect(JSON.parse(sync.match(/^const workflows = (\[.*\])$/m)?.[1] ?? "[]")).toEqual(active)
})

test("polls hourly or on demand, one run at a time", () => {
  const triggers = [workflow.on, workflow.true].filter((value) => value !== undefined)
  expect(triggers).toHaveLength(1)
  const [on] = triggers
  expect(Object.keys(on).sort()).toEqual(["schedule", "workflow_dispatch"])
  expect(on.schedule).toHaveLength(1)
  const [minute, ...rest] = on.schedule[0].cron.split(" ")
  expect(rest).toEqual(["*", "*", "*", "*"])
  // Scheduled runs over one day: one per hour.
  const day = Array.from({ length: 24 * 60 }, (_, index) => index).filter((index) => index % 60 === Number(minute))
  expect(day).toHaveLength(24)
  expect(workflow.concurrency).toEqual({ group: "vysus-upstream-sync", "cancel-in-progress": false })
  expect(workflow.jobs.plan["runs-on"]).toBe("ubuntu-latest")
  expect(workflow.jobs.plan.if).toBe("github.repository == 'vagdotdev/VABLITERATION'")
})

test("only the job that runs no repository code can write, and no stored secret is used", () => {
  expect(workflow.permissions).toEqual({})
  expect(Object.fromEntries(Object.entries(workflow.jobs).map(([name, job]) => [name, job.permissions]))).toEqual({
    plan: { contents: "read" },
    check: { contents: "read" },
    build: { contents: "read" },
    publish: { contents: "write" },
  })
  expect(text).not.toContain("secrets.")
  expect(text).not.toContain("pull-requests")
  expect(text).not.toContain("pull_request")
  expect(
    Object.entries(workflow.jobs).flatMap(([name, job]) =>
      job.steps.filter((step) => JSON.stringify(step.env ?? {}).includes("github.token")).map(() => name),
    ),
  ).toEqual(["plan", "publish"])

  // plan and publish hold tokens: they may only check out, move artifacts, and run their own script.
  for (const [name, script] of [
    ["plan", "bash vysus/script/plan "],
    ["publish", "bash vysus/script/publish "],
  ] as const) {
    const job = workflow.jobs[name]
    expect(job["runs-on"]).toBe("ubuntu-latest")
    for (const step of job.steps) {
      if (step.uses) expect(step.uses).toMatch(/^actions\/(checkout|upload-artifact|download-artifact)@/)
      else expect(step.run?.startsWith(script)).toBe(true)
    }
  }
  // check and build run upstream code: no credentials in the checkout.
  for (const name of ["check", "build"]) {
    const checkout = workflow.jobs[name].steps.find((step) => step.uses?.startsWith("actions/checkout@"))
    expect(checkout?.with?.["persist-credentials"]).toBe(false)
  }
  const actions = Object.values(workflow.jobs).flatMap((job) => job.steps.flatMap((step) => step.uses ?? []))
  for (const action of actions.filter((action) => !action.startsWith("./")))
    expect(action).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/)
})

test("publishes only after checks and the macOS build of the planned version pass", () => {
  const jobs = workflow.jobs
  expect([jobs.publish.needs].flat().sort()).toEqual(["build", "check", "plan"])
  expect(jobs.publish.if).toBeUndefined()
  for (const name of ["check", "build"]) {
    expect(jobs[name].needs).toBe("plan")
    expect(jobs[name].if).toBe("needs.plan.outputs.action != 'none'")
  }
  expect(jobs.check["runs-on"]).toBe("ubuntu-latest")
  expect(jobs.build["runs-on"]).toBe("macos-latest")
  expect(Object.values(jobs).flatMap((job) => job.steps).some((step) => "continue-on-error" in step)).toBe(false)
  expect(jobs.check.steps.at(-1)?.run).toBe("bun vysus/script/sync-upstream.ts --validate --skip-build")

  const steps = jobs.build.steps.map((step) => step.name)
  const release = jobs.build.steps.find((step) => step.name === "Build and verify release")
  expect(release?.run).toBe('bun vysus/script/release.ts --version "$VERSION"')
  expect(release?.env?.VERSION).toBe("${{ needs.plan.outputs.version }}")
  expect(steps.indexOf("Build and verify release")).toBeLessThan(
    steps.indexOf("Install an older build and upgrade to the release"),
  )
  expect(steps.indexOf("Install an older build and upgrade to the release")).toBe(
    steps.indexOf("Upload release assets") - 1,
  )
  expect(steps.at(-1)).toBe("Upload release assets")
})
