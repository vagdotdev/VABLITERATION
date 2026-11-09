import { afterAll, expect, test } from "bun:test"
import { cp, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

// Runs vysus/script/plan and vysus/script/publish the way the vysus upstream sync workflow does: every job in a
// fresh depth-1 checkout of a bare fork repository, upstream as a separate repository, and a fake gh whose
// releases create tags in the fork repository like GitHub does.
const root = path.resolve(import.meta.dirname, "../../..")
const sandboxes: string[] = []
afterAll(() => Promise.all(sandboxes.map((dir) => rm(dir, { recursive: true, force: true }))))

// Like GitHub, deleting a release keeps its tag, and creating one on an existing tag reuses that tag.
const gh = `#!/bin/sh
echo "$*" >>"$FAKE_GH/calls"
case "$1 $2" in
  "release view")
    if [ -n "$FAKE_GH_DOWN" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
    [ -d "$FAKE_GH/$3" ] || { echo "release not found" >&2; exit 1; }
    draft=false
    if [ -f "$FAKE_GH/$3/.draft" ]; then draft=true; fi
    assets="$(ls "$FAKE_GH/$3" | sed 's/.*/{"name":"&","state":"uploaded"}/' | paste -sd , -)"
    echo "{\\"isDraft\\":$draft,\\"assets\\":[$assets]}" ;;
  "release delete") rm -rf "$FAKE_GH/$3" ;;
  "release create" | "release upload")
    if [ -n "$FAKE_GH_FAIL" ]; then echo "HTTP 502" >&2; exit 1; fi
    tag="$3"
    shift 3
    mkdir -p "$FAKE_GH/$tag"
    while [ $# -gt 0 ]; do
      case "$1" in
        --target) target="$2" && shift 2 ;;
        --repo | --title | --notes) shift 2 ;;
        --latest | --clobber) shift ;;
        *) cp "$1" "$FAKE_GH/$tag/" && shift ;;
      esac
    done
    if [ -n "$target" ] && ! git --git-dir="$FAKE_GH_ORIGIN" rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
      git --git-dir="$FAKE_GH_ORIGIN" tag "$tag" "$target"
    fi ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`

function app(name: string, feature: string) {
  return `name=${name}\n1\n2\n3\n4\nfeature=${feature}\n`
}

async function fixture() {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "vysus-pipeline-")))
  sandboxes.push(dir)
  const upstream = path.join(dir, "upstream")
  const fork = path.join(dir, "fork.git")
  const releases = path.join(dir, "releases")
  const env = {
    HOME: path.join(dir, "home"),
    PATH: `${path.join(dir, "bin")}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "vysus test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "vysus test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    FAKE_GH: releases,
    FAKE_GH_ORIGIN: fork,
  }
  const sh = (cwd: string, command: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync(command, { cwd, env: { ...env, ...extra }, stdin: "ignore" })
    return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
  }
  const git = (cwd: string, ...args: string[]) => {
    const result = sh(cwd, ["git", ...args])
    if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.err}`)
    return result.out.trim()
  }
  const write = async (repo: string, files: Record<string, string>) => {
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repo, file)), { recursive: true })
      await writeFile(path.join(repo, file), text)
    }
  }
  const commit = async (repo: string, files: Record<string, string>) => {
    await write(repo, files)
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "change")
    return git(repo, "rev-parse", "HEAD")
  }

  await mkdir(path.join(dir, "bin"))
  await mkdir(releases)
  await writeFile(path.join(dir, "bin", "gh"), gh, { mode: 0o755 })
  await mkdir(upstream)
  git(upstream, "init", "-q", "-b", "v2")
  const first = await commit(upstream, {
    "package.json": `{ "name": "opencode", "version": "1.2.3" }\n`,
    "app.txt": app("OpenCode", "one"),
    ".github/workflows/test.yml": "name: test\n",
    ".github/actions/setup-bun/action.yml": "name: setup-bun 1\n",
    ".github/actions/setup-git-committer/action.yml": "name: committer\n",
  })
  // The fork as this repository lays it out: branding, parked upstream workflows, and the pipeline scripts.
  const work = path.join(dir, "work")
  git(dir, "clone", "-q", "-b", "v2", upstream, work)
  await mkdir(path.join(work, "vysus", "upstream-github", "actions"), { recursive: true })
  git(work, "mv", ".github/workflows", "vysus/upstream-github/workflows")
  git(work, "mv", ".github/actions/setup-git-committer", "vysus/upstream-github/actions/setup-git-committer")
  await mkdir(path.join(work, "vysus", "script"), { recursive: true })
  for (const name of ["integrate", "plan", "publish", "release-state"])
    await cp(path.join(root, "vysus", "script", name), path.join(work, "vysus", "script", name))
  await commit(work, {
    "app.txt": app("MyVy", "one"),
    ".github/workflows/vysus-upstream-sync.yml": "name: vysus upstream sync\n",
    "vysus/script/upstream-commit": `${first}\n`,
  })
  git(dir, "init", "-q", "--bare", "-b", "v2", fork)
  git(fork, "config", "uploadpack.allowAnySHA1InWant", "true")
  git(work, "push", "-q", fork, "v2")

  // A depth-1 checkout, like actions/checkout.
  const checkout = async (ref: string) => {
    const job = await mkdtemp(path.join(dir, "job-"))
    git(job, "init", "-q")
    git(job, "remote", "add", "origin", `file://${fork}`)
    git(job, "fetch", "-q", "--depth=1", "origin", ref)
    git(job, "checkout", "-q", "--detach", "FETCH_HEAD")
    return job
  }
  const plan = async (extra: Record<string, string> = {}) => {
    const job = await checkout("v2")
    const bundle = `${job}.bundle`
    const result = sh(job, ["bash", "vysus/script/plan", "--remote", upstream, "--bundle", bundle], extra)
    const outputs = Object.fromEntries(
      result.out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    )
    return { ...result, job, bundle, outputs }
  }
  // What the build job uploads: both archives, their checksums, and release.json.
  const build = async (outputs: Record<string, string>) => {
    const assets = await mkdtemp(path.join(dir, "assets-"))
    const sums = []
    for (const name of ["vysus-darwin-arm64.tar.gz", "vysus-darwin-x64.tar.gz"]) {
      await writeFile(path.join(assets, name), `${name} ${outputs.version}`)
      sums.push(`${new Bun.CryptoHasher("sha256").update(`${name} ${outputs.version}`).digest("hex")}  ${name}`)
    }
    await writeFile(path.join(assets, "SHA256SUMS"), sums.join("\n") + "\n")
    await writeFile(
      path.join(assets, "release.json"),
      JSON.stringify({ version: outputs.version, upstream: "1.2.3", commit: outputs.commit }),
    )
    return assets
  }
  const publish = async (
    planned: { outputs: Record<string, string>; bundle: string },
    assets: string,
    extra: Record<string, string> = {},
  ) =>
    sh(
      await checkout(planned.outputs.base),
      [
        "bash",
        "vysus/script/publish",
        ...["--base", planned.outputs.base, "--commit", planned.outputs.commit, "--version", planned.outputs.version],
        ...["--assets", assets, "--bundle", planned.bundle, "--repo", "vagdotdev/VABLITERATION"],
      ],
      extra,
    )
  // One scheduled run: plan, then build and publish unless there is nothing to do.
  const tick = async () => {
    const planned = await plan()
    if (planned.code !== 0) throw new Error(`plan failed: ${planned.err}`)
    if (planned.outputs.action === "none") return planned.outputs
    const published = await publish(planned, await build(planned.outputs))
    if (published.code !== 0) throw new Error(`publish failed: ${published.err}`)
    return planned.outputs
  }
  const calls = async () => {
    const file = Bun.file(path.join(releases, "calls"))
    return (await file.exists()) ? (await file.text()).trim().split("\n") : []
  }
  const creates = async () => (await calls()).filter((call) => call.startsWith("release create"))
  const tags = () => git(fork, "for-each-ref", "--format=%(refname:short) %(objectname)", "refs/tags")

  return {
    dir,
    upstream,
    fork,
    releases,
    sh,
    git,
    commit,
    checkout,
    plan,
    build,
    publish,
    tick,
    calls,
    creates,
    tags,
    head: () => git(fork, "rev-parse", "v2"),
  }
}

test("releases the v2 head once, then polls without building", async () => {
  const f = await fixture()
  const head = f.head()
  const first = await f.plan()
  expect(first.code).toBe(0)
  expect(first.outputs).toEqual({ action: "release", base: head, commit: head, version: "1.2.3-vysus.1" })

  const published = await f.publish(first, await f.build(first.outputs))
  expect(published.code).toBe(0)
  expect(f.head()).toBe(head)
  expect(f.tags()).toBe(`v1.2.3-vysus.1 ${head}`)
  const creates = await f.creates()
  expect(creates).toHaveLength(1)
  expect(creates[0]).toContain(`--target ${head} --latest`)

  const second = await f.plan()
  expect(second.code).toBe(0)
  expect(second.outputs).toEqual({ action: "none", base: head, commit: head, version: "" })
})

test("integrates upstream as one sanitized single-parent commit and releases it", async () => {
  const f = await fixture()
  await f.tick()
  const base = f.head()
  const upstream = await f.commit(f.upstream, {
    "package.json": `{ "name": "opencode", "version": "1.2.4" }\n`,
    "app.txt": app("OpenCode", "two"),
    ".github/workflows/test.yml": "name: test 2\n",
    ".github/workflows/new.yml": "name: new\n",
    ".github/actions/setup-bun/action.yml": "name: setup-bun 2\n",
  })

  const planned = await f.plan()
  expect(planned.code).toBe(0)
  expect(planned.outputs.action).toBe("integrate")
  expect(planned.outputs.base).toBe(base)
  expect(planned.outputs.version).toBe("1.2.4-vysus.1")
  const commit = planned.outputs.commit
  const show = (file: string) => f.git(planned.job, "show", `${commit}:${file}`)
  expect(f.git(planned.job, "rev-list", "--parents", "-n", "1", commit)).toBe(`${commit} ${base}`)
  expect(f.git(planned.job, "diff", "--name-only", base, commit, "--", ".github/workflows")).toBe("")
  expect(f.git(planned.job, "ls-tree", "--name-only", `${commit}:.github/workflows`)).toBe("vysus-upstream-sync.yml")
  expect(show("app.txt")).toBe(app("MyVy", "two").trim())
  expect(show("vysus/upstream-github/workflows/test.yml")).toBe("name: test 2")
  expect(show("vysus/upstream-github/workflows/new.yml")).toBe("name: new")
  expect(show("vysus/upstream-github/actions/setup-git-committer/action.yml")).toBe("name: committer")
  expect(show(".github/actions/setup-bun/action.yml")).toBe("name: setup-bun 2")
  expect(show("vysus/script/upstream-commit")).toBe(upstream)

  const published = await f.publish(planned, await f.build(planned.outputs))
  expect(published.code).toBe(0)
  expect(f.head()).toBe(commit)
  expect(f.tags()).toContain(`v1.2.4-vysus.1 ${commit}`)
  // Upstream history never reaches the fork repository.
  expect(f.sh(f.fork, ["git", "cat-file", "-e", `${upstream}^{commit}`]).code).not.toBe(0)
  expect((await f.plan()).outputs.action).toBe("none")
})

test("simulated hourly runs release once per change and coalesce upstream commits", async () => {
  const f = await fixture()
  const runs = []
  runs.push(await f.tick())
  runs.push(await f.tick())
  await f.commit(f.upstream, { "app.txt": app("OpenCode", "two") })
  runs.push(await f.tick())
  runs.push(await f.tick())
  await f.commit(f.upstream, { "app.txt": app("OpenCode", "three") })
  const latest = await f.commit(f.upstream, { "app.txt": app("OpenCode", "four") })
  const before = f.head()
  runs.push(await f.tick())
  expect(f.git(f.fork, "rev-list", "--count", `${before}..v2`)).toBe("1")
  expect(f.git(f.fork, "show", "v2:vysus/script/upstream-commit")).toBe(latest)
  // A change a person pushes is released as it is, before upstream is integrated again.
  const dev = path.join(f.dir, "dev")
  f.git(f.dir, "clone", "-q", "-b", "v2", f.fork, dev)
  await f.commit(dev, { "notes.txt": "fork change\n" })
  f.git(dev, "push", "-q", "origin", "v2")
  runs.push(await f.tick())
  runs.push(await f.tick())

  expect(runs.map((run) => `${run.action} ${run.version}`.trim())).toEqual([
    "release 1.2.3-vysus.1",
    "none",
    "integrate 1.2.3-vysus.2",
    "none",
    "integrate 1.2.3-vysus.3",
    "release 1.2.3-vysus.4",
    "none",
  ])
  expect(await f.creates()).toHaveLength(4)
})

test("a merge conflict fails the plan before anything is pushed, and a person can finish it", async () => {
  const f = await fixture()
  await f.tick()
  const base = f.head()
  const tags = f.tags()
  const upstream = await f.commit(f.upstream, { "app.txt": app("OpenCode 2", "two") })

  const planned = await f.plan()
  expect(planned.code).toBe(2)
  expect(planned.out).toBe("")
  expect(planned.err).toContain("stopped on conflicts in:\napp.txt")
  expect(await Bun.file(planned.bundle).exists()).toBe(false)
  expect(f.head()).toBe(base)
  expect(f.tags()).toBe(tags)
  expect(await f.creates()).toHaveLength(1)

  // The documented manual path: integrate, resolve, continue, and push to v2.
  const dev = path.join(f.dir, "dev")
  f.git(f.dir, "clone", "-q", "-b", "v2", f.fork, dev)
  const stopped = f.sh(dev, ["bash", "vysus/script/integrate", "--remote", f.upstream])
  expect(stopped.code).toBe(2)
  const early = f.sh(dev, ["bash", "vysus/script/integrate", "--continue"])
  expect(early.code).not.toBe(0)
  expect(early.err).toContain("resolve every conflict")
  await writeFile(path.join(dev, "app.txt"), app("MyVy", "two"))
  f.git(dev, "add", "app.txt")
  const resolved = f.sh(dev, ["bash", "vysus/script/integrate", "--continue"])
  expect(resolved.code).toBe(0)
  const commit = resolved.out.trim()
  expect(f.git(dev, "rev-list", "--parents", "-n", "1", commit)).toBe(`${commit} ${base}`)
  expect(f.git(dev, "rev-parse", "--abbrev-ref", "HEAD")).toBe(`sync-${upstream.slice(0, 10)}`)
  expect(f.git(dev, "status", "--porcelain")).toBe("")
  expect(f.git(dev, "show", `${commit}:vysus/script/upstream-commit`)).toBe(upstream)
  f.git(dev, "push", "-q", "origin", "HEAD:v2")

  expect(await f.tick()).toMatchObject({ action: "release", commit, version: "1.2.3-vysus.2" })
  expect((await f.plan()).outputs.action).toBe("none")
})

test("refuses upstream changes to vysus/ and rewritten upstream history", async () => {
  const f = await fixture()
  await f.tick()
  const base = f.head()
  await f.commit(f.upstream, { "vysus/script/publish": "echo replaced\n" })
  const owned = await f.plan()
  expect(owned.code).not.toBe(0)
  expect(owned.err).toContain("upstream changed files under vysus/")

  f.git(f.upstream, "reset", "-q", "--hard", "HEAD~1")
  f.git(f.upstream, "commit", "-q", "--amend", "-m", "rewritten")
  const rewritten = await f.plan()
  expect(rewritten.code).not.toBe(0)
  expect(rewritten.err).toContain("its history was rewritten")
  expect(f.head()).toBe(base)
  expect(await f.creates()).toHaveLength(1)
})

test("publish refuses artifacts and commits that do not match the plan", async () => {
  const f = await fixture()
  await f.tick()
  const base = f.head()
  await f.commit(f.upstream, { "app.txt": app("OpenCode", "two") })
  const planned = await f.plan()
  expect(planned.outputs.action).toBe("integrate")
  const refused = async (assets: string, message: string, outputs = planned.outputs, bundle = planned.bundle) => {
    const result = await f.publish({ outputs, bundle }, assets)
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(message)
  }

  const wrongCommit = await f.build({ ...planned.outputs, commit: base })
  await refused(wrongCommit, "release.json does not describe")
  const tampered = await f.build(planned.outputs)
  await writeFile(path.join(tampered, "vysus-darwin-x64.tar.gz"), "replaced")
  await refused(tampered, "SHA256SUMS does not match")
  const extra = await f.build(planned.outputs)
  await writeFile(path.join(extra, "install"), "#!/bin/sh\n")
  await refused(extra, "must hold exactly")
  await refused(path.join(f.dir, "missing"), "must hold exactly")

  // Commits that would need the workflows permission or change the scripts later runs execute.
  const dev = path.join(f.dir, "dev")
  f.git(f.dir, "clone", "-q", "-b", "v2", f.fork, dev)
  for (const [file, message] of [
    [".github/workflows/extra.yml", "only a person may change: .github/workflows/extra.yml"],
    ["vysus/script/publish", "only a person may change: vysus/script/publish"],
  ]) {
    f.git(dev, "checkout", "-q", "--detach", base)
    const commit = await f.commit(dev, { [file]: "changed\n" })
    const bundle = path.join(f.dir, `evil-${path.basename(file)}.bundle`)
    f.git(dev, "bundle", "create", "-q", bundle, "HEAD", `^${base}`)
    const outputs = { ...planned.outputs, commit }
    await refused(await f.build(outputs), message, outputs, bundle)
  }
  f.git(dev, "checkout", "-q", "--detach", base)
  const side = await f.commit(dev, { "side.txt": "side\n" })
  f.git(dev, "checkout", "-q", "--detach", base)
  await f.commit(dev, { "other.txt": "other\n" })
  f.git(dev, "merge", "-q", "--no-edit", side)
  const merge = f.git(dev, "rev-parse", "HEAD")
  const mergeBundle = path.join(f.dir, "merge.bundle")
  f.git(dev, "bundle", "create", "-q", mergeBundle, "HEAD", `^${base}`)
  const mergeOutputs = { ...planned.outputs, commit: merge }
  await refused(await f.build(mergeOutputs), "is not a single-parent child", mergeOutputs, mergeBundle)

  expect(f.head()).toBe(base)
  expect(await f.creates()).toHaveLength(1)
  const published = await f.publish(planned, await f.build(planned.outputs))
  expect(published.code).toBe(0)
  expect(f.head()).toBe(planned.outputs.commit)
})

test("publish is safe to repeat: it finishes a failed release, replaces a draft, and skips a duplicate", async () => {
  const f = await fixture()
  await f.tick()
  await f.commit(f.upstream, { "app.txt": app("OpenCode", "two") })
  const planned = await f.plan()
  const assets = await f.build(planned.outputs)
  const tag = `v${planned.outputs.version}`

  const failed = await f.publish(planned, assets, { FAKE_GH_FAIL: "1" })
  expect(failed.code).not.toBe(0)
  expect(f.head()).toBe(planned.outputs.commit)
  expect(f.tags()).not.toContain(tag)

  await mkdir(path.join(f.releases, tag))
  await writeFile(path.join(f.releases, tag, ".draft"), "")
  const retried = await f.publish(planned, assets)
  expect(retried.code).toBe(0)
  expect((await f.calls()).filter((call) => call.startsWith(`release delete ${tag}`))).toHaveLength(1)
  expect(f.tags()).toContain(`${tag} ${planned.outputs.commit}`)

  const created = (await f.creates()).length
  const duplicate = await f.publish(planned, assets)
  expect(duplicate.code).toBe(0)
  expect(duplicate.err).toContain("already released")
  expect(await f.creates()).toHaveLength(created)
  expect((await f.plan()).outputs.action).toBe("none")
})

test("a tag on the v2 head whose release is missing or a draft is released again under its version", async () => {
  const f = await fixture()
  await f.tick()
  const head = f.head()
  const tag = "v1.2.3-vysus.1"
  for (const left of ["missing", "draft"]) {
    // What a run leaves when it fails after the tag exists: no release, or a draft without assets.
    await rm(path.join(f.releases, tag), { recursive: true, force: true })
    if (left === "draft") {
      await mkdir(path.join(f.releases, tag))
      await writeFile(path.join(f.releases, tag, ".draft"), "")
    }
    expect(f.tags()).toBe(`${tag} ${head}`)
    const planned = await f.plan()
    expect(planned.code).toBe(0)
    expect(planned.outputs).toEqual({ action: "release", base: head, commit: head, version: "1.2.3-vysus.1" })
    const published = await f.publish(planned, await f.build(planned.outputs))
    expect(published.code).toBe(0)
    expect(published.err).toContain(`released ${tag}`)
    expect(await Bun.file(path.join(f.releases, tag, ".draft")).exists()).toBe(false)
    expect(await Bun.file(path.join(f.releases, tag, "vysus-darwin-x64.tar.gz")).exists()).toBe(true)
    expect(f.tags()).toBe(`${tag} ${head}`)
    expect((await f.plan()).outputs.action).toBe("none")
  }
  expect((await f.calls()).filter((call) => call.startsWith(`release delete ${tag}`))).toHaveLength(1)
  expect(await f.creates()).toHaveLength(3)
})

test("publish uploads the assets again when a published release is missing one", async () => {
  const f = await fixture()
  await f.tick()
  const tag = "v1.2.3-vysus.1"
  await rm(path.join(f.releases, tag, "vysus-darwin-x64.tar.gz"))
  const planned = await f.plan()
  expect(planned.outputs).toMatchObject({ action: "release", version: "1.2.3-vysus.1" })
  const published = await f.publish(planned, await f.build(planned.outputs))
  expect(published.code).toBe(0)
  const uploads = (await f.calls()).filter((call) => call.startsWith(`release upload ${tag} `))
  expect(uploads).toHaveLength(1)
  expect(uploads[0]).toEndWith("--clobber")
  expect(await f.creates()).toHaveLength(1)
  expect(await Bun.file(path.join(f.releases, tag, "vysus-darwin-x64.tar.gz")).exists()).toBe(true)
  expect((await f.plan()).outputs.action).toBe("none")
})

test("a GitHub outage fails the plan instead of releasing the v2 head again", async () => {
  const f = await fixture()
  await f.tick()
  const planned = await f.plan({ FAKE_GH_DOWN: "1" })
  expect(planned.code).not.toBe(0)
  expect(planned.out).toBe("")
  expect(planned.err).toContain("HTTP 502")
})

test("publish fails when v2 moved during the run and leaves it alone", async () => {
  const f = await fixture()
  await f.tick()
  await f.commit(f.upstream, { "app.txt": app("OpenCode", "two") })
  const planned = await f.plan()
  const dev = path.join(f.dir, "dev")
  f.git(f.dir, "clone", "-q", "-b", "v2", f.fork, dev)
  const moved = await f.commit(dev, { "notes.txt": "pushed meanwhile\n" })
  f.git(dev, "push", "-q", "origin", "v2")

  const result = await f.publish(planned, await f.build(planned.outputs))
  expect(result.code).not.toBe(0)
  expect(result.err).toContain("v2 moved")
  expect(f.head()).toBe(moved)
  expect(await f.creates()).toHaveLength(1)
  expect((await f.plan()).outputs).toMatchObject({ action: "release", commit: moved })
})
