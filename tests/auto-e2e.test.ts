/**
 * Local auto mode end to end, offline (ADR 014 gate B1): the terminal client
 * starts a detached runner for the 5-case gate plan against a scripted model
 * behind a fake Poundlock and a fake Docker CLI. The runner is killed with
 * SIGKILL in the middle of case C3, resumed, and finishes; the export applies
 * with `git apply --check` to a clean clone of the base. The same plan is
 * the live gate on a real profile.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { cp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, readRunFile, runnerPid, runsForSource } from "@core/auto/runs";
import { FileStore } from "@core/store";
import { build } from "vite";
import { describe, expect, it } from "vitest";
import { runAuto } from "../src/tui/auto";
import { fakeDocker } from "./support/fake-docker";
import {
  type ChatRequest,
  fakePoundlock,
  messageText,
  type ScriptedTurn,
} from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const FIXTURE = resolve("tests/fixtures/auto-gate");

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

const unit = (name: string, body: string, check: string) => ({
  files: [
    { path: `src/${name}.js`, content: body },
    {
      path: `test/${name}.test.js`,
      content: `import assert from "node:assert/strict";\nimport test from "node:test";\n${check}\n`,
    },
  ],
});

/** What the scripted model writes for each case of the gate plan. */
const WORK: Record<string, { files: Array<{ path: string; content: string }>; command?: string }> =
  {
    C1: unit(
      "slugify",
      'export function slugify(text) {\n  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n}\n',
      'import { slugify } from "../src/slugify.js";\n\ntest("slugify", () => assert.equal(slugify("  Hello, World! "), "hello-world"));',
    ),
    C2: {
      ...unit(
        "title-case",
        'import { words } from "./words.js";\n\nexport function titleCase(text) {\n  return words(text)\n    .map((word) => word[0].toUpperCase() + word.slice(1).toLowerCase())\n    .join(" ");\n}\n',
        'import { titleCase } from "../src/title-case.js";\n\ntest("titleCase", () => assert.equal(titleCase("hELLO   wORLD"), "Hello World"));',
      ),
      // A test runner's cache, outside the case's writable paths: never a violation, never committed.
      command: "mkdir -p .pytest_cache/v && echo {} > .pytest_cache/v/lastfailed && node --test",
    },
    C3: unit(
      "word-count",
      'import { words } from "./words.js";\n\nexport function wordCount(text) {\n  return words(text).length;\n}\n',
      'import { wordCount } from "../src/word-count.js";\n\ntest("wordCount", () => {\n  assert.equal(wordCount(""), 0);\n  assert.equal(wordCount(" a b  c "), 3);\n});',
    ),
    C4: unit(
      "truncate",
      "export function truncate(text, max) {\n  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;\n}\n",
      'import { truncate } from "../src/truncate.js";\n\ntest("truncate", () => {\n  assert.equal(truncate("abcdef", 4), "abc…");\n  assert.equal(truncate("abc", 4), "abc");\n});',
    ),
    C5: {
      files: [
        {
          path: "README.md",
          content:
            "# auto-gate\n\nA small text library, grown one function at a time by a Dispatch auto run.\n\n## Usage\n\n- `words(text)`: the words. `words(' a b ')` is `['a', 'b']`.\n- `slugify(text)`: a URL slug. `slugify('Hello, World!')` is `'hello-world'`.\n- `titleCase(text)`: each word capitalised. `titleCase('hELLO wORLD')` is `'Hello World'`.\n- `wordCount(text)`: how many words. `wordCount('a b')` is `2`.\n- `truncate(text, max)`: at most max characters. `truncate('abcdef', 4)` is `'abc…'`.\n",
        },
      ],
    },
  };

/** The case an attempt works on, and how many tool calls it has made since its brief. */
function position(request: ChatRequest): { caseId: string; step: number } {
  const briefs = request.messages
    .map((m, index) => ({
      index,
      match: m.role === "user" ? /## Case (C\d)/.exec(messageText(m)) : null,
    }))
    .filter((m) => m.match);
  const last = briefs.at(-1);
  if (!last?.match) throw new Error("no case brief in the request");
  const step = request.messages
    .slice(last.index + 1)
    .reduce((n, m) => n + ((m.tool_calls as unknown[] | undefined)?.length ?? 0), 0);
  return { caseId: last.match[1], step };
}

function deferred() {
  let settle: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    settle = done;
  });
  return { promise, settle };
}

async function until<T>(check: () => Promise<T | undefined>, ms: number, what: string): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("local auto mode, end to end (offline)", () => {
  it("runs a 5-case plan, survives kill -9 of its runner, resumes, and exports a patch that applies", async () => {
    // The entry must end in tui/index.js: that is how the bundle knows it is the program.
    const outDir = resolve(`out/auto-e2e-${process.pid}/tui`);
    const runners: ChildProcess[] = [];
    await build({
      configFile: resolve("vite.tui.config.ts"),
      logLevel: "silent",
      build: { outDir, emptyOutDir: true, sourcemap: false },
    });
    const entry = join(outDir, "index.js");

    const root = await realpath(await tempDir("auto-e2e-"));
    const data = join(root, "data");
    const config = join(root, "config");
    const source = join(root, "gate");
    await cp(join(FIXTURE, "project"), source, { recursive: true });
    git(source, "init", "-q", "-b", "main");
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "gate base");
    const base = git(source, "rev-parse", "HEAD");

    const c3Hung = deferred();
    const c4Release = deferred();
    const c4Asked = deferred();
    let hungOnce = false;
    const firstSteps: string[] = [];
    const server = await fakePoundlock({
      respond: (request): ScriptedTurn => {
        const { caseId, step } = position(request);
        const work = WORK[caseId];
        if (step === 0) firstSteps.push(caseId);
        if (caseId === "C3" && step === 1 && !hungOnce) {
          hungOnce = true;
          c3Hung.settle();
          return { hang: true };
        }
        const delay = caseId === "C4" && step === 0 ? c4Release.promise : undefined;
        if (delay) c4Asked.settle();
        if (step < work.files.length)
          return { delay, toolCalls: [{ name: "write", arguments: { ...work.files[step] } }] };
        if (step === work.files.length)
          return {
            toolCalls: [{ name: "bash", arguments: { command: work.command ?? "node --test" } }],
          };
        return {
          toolCalls: [
            {
              name: "finish_case",
              arguments: {
                status: "done",
                summary: `${caseId} done`,
                learnings: [`${caseId} used node:test`],
              },
            },
          ],
        };
      },
    });
    const store = new FileStore(data, config);
    await store.init();
    await store.saveConnection({ url: server.url, token: server.token, roles: {}, profiles: {} });

    const docker = await fakeDocker(["toolchain:test"]);
    const bin = join(root, "bin");
    await cp(resolve("tests/support/fake-docker-cli.mjs"), join(bin, "fake-docker.mjs"));
    await symlink(join(bin, "fake-docker.mjs"), join(bin, "docker"));
    // The home folder the runner checks the VM against: the fake VM runs
    // commands on this machine, so it shows whatever this folder holds.
    const home = join(root, "home");
    await mkdir(home);
    const env = {
      ...docker.env,
      HOME: home,
      POUNDLOCK_DISPATCH_DATA_DIR: data,
      POUNDLOCK_CONFIG_DIR: config,
      PATH: `${bin}:${process.env.PATH}`,
    };
    const output: string[] = [];
    const paths = new AutoPaths(data);
    const cli = (...argv: string[]) =>
      runAuto(argv, {
        paths,
        connection: () => store.getConnection(),
        project: async () => undefined,
        entry,
        io: { out: (text) => output.push(text), err: (text) => output.push(text) },
        docker: join(bin, "docker"),
        dockerEnv: env,
        home,
        spawnRunner: (runDir) => {
          const log = openSync(join(runDir, "runner.log"), "a");
          const child = spawn(process.execPath, [entry, "auto", "run", runDir], {
            detached: true,
            stdio: ["ignore", log, log],
            env,
          });
          closeSync(log);
          runners.push(child);
        },
        sleep: (ms) => new Promise((done) => setTimeout(done, Math.min(ms, 200))),
      });

    try {
      // Start: foreground checks, then the detached runner prepares and checks the base.
      const started = await cli(
        "start",
        "--dir",
        source,
        "--image",
        "toolchain:test",
        "--plan",
        join(FIXTURE, "plan.json"),
        "--profile",
        "gate-model",
      );
      const runnerLogs = async () => {
        const runs = await runsForSource(paths, source);
        return (
          await Promise.all(
            runs.map((r) => readFile(join(r.runDir, "runner.log"), "utf8").catch(() => "")),
          )
        ).join("\n");
      };
      expect(started, `${output.join("")}\n${await runnerLogs()}`).toBe(0);
      expect(output.join("")).toContain("The base checks pass; cases are running.");
      const [latest] = await runsForSource(paths, source);
      const runDir = latest.runDir;
      const run = await readRunFile(runDir);
      const ledger = new AutoLedger(runDir);

      // Kill the runner with SIGKILL in the middle of C3, after it wrote a file.
      await Promise.race([
        c3Hung.promise,
        until(async () => undefined, 60_000, "C3 to be under way"),
      ]);
      const firstPid = await runnerPid(runDir);
      expect(firstPid).toBeDefined();
      process.kill(firstPid!, "SIGKILL");
      await until(async () => (alive(firstPid!) ? undefined : true), 10_000, "the runner to die");
      let state = await ledger.state();
      expect(state.cases.map((c) => c.stage)).toEqual([
        "accepted",
        "accepted",
        "running",
        "pending",
        "pending",
      ]);
      expect(state.current?.caseId).toBe("C3");
      output.length = 0;
      await cli("status", run.runId);
      expect(output.join("")).toContain("The runner is not running");

      // Resume. A second runner is refused while the first is alive.
      output.length = 0;
      expect(await cli("resume", run.runId)).toBe(0);
      await c4Asked.promise;
      output.length = 0;
      expect(await cli("resume", run.runId)).toBe(1);
      expect(output.join("")).toContain("already running");
      c4Release.settle();
      state = await until(
        async () => {
          const current = await ledger.state();
          return current.outcome ? current : undefined;
        },
        60_000,
        "the run to end",
      );

      expect(state.outcome, state.endReason).toBe("objective_met");
      expect(state.cases.map((c) => c.stage)).toEqual(Array(5).fill("accepted"));
      // Accepted cases were never worked again; only the interrupted one restarted.
      expect(firstSteps).toEqual(["C1", "C2", "C3", "C3", "C4", "C5"]);
      expect(
        state.cases.find((c) => c.id === "C3")?.drafts.some((d) => d.includes("interrupted")),
      ).toBe(true);
      const events = (await ledger.read()).map((e) => e.event);
      expect(events.filter((e) => e.type === "scope")).toEqual([]);
      expect(events.filter((e) => e.type === "run_resumed")).toHaveLength(1);

      // The branch holds one verified, not reviewed checkpoint per case, and no cache.
      const mirror = ["--git-dir", run.mirror];
      expect(
        git(root, ...mirror, "log", "--format=%s", `${base}..${run.branch}`).split("\n"),
      ).toEqual([
        "auto: C5 document the library",
        "auto: C4 truncate",
        "auto: C3 wordCount",
        "auto: C2 titleCase",
        "auto: C1 slugify",
      ]);
      expect(git(root, ...mirror, "log", "--format=%b", `${base}..${run.branch}`)).toContain(
        "Verified, not reviewed",
      );
      expect(
        git(root, ...mirror, "log", "--name-only", "--format=", `${base}..${run.branch}`),
      ).not.toContain(".pytest_cache");

      // Every check and every shell command ran through the container.
      const calls = await docker.calls();
      const execs = calls.filter((c) => c[0] === "exec" && c.includes(run.container));
      expect(execs.some((c) => c.at(-1) === "node --test")).toBe(true);
      expect(execs.some((c) => c.at(-1) === WORK.C2.command)).toBe(true);
      expect(calls.some((c) => c[0] === "pull" || c[0] === "build")).toBe(false);

      // Export, then apply to a clean clone of the base.
      output.length = 0;
      const patch = join(root, "gate.patch");
      expect(await cli("export", run.runId, "--out", patch)).toBe(0);
      expect(output.join("")).toContain("verified, not reviewed");
      const text = await readFile(patch, "utf8");
      expect(text.split("\n")[0]).toBe(`# Dispatch auto run ${run.runId}: verified, not reviewed.`);
      const clean = join(root, "clean");
      execFileSync("git", ["clone", "-q", source, clean]);
      execFileSync("git", ["apply", "--check", patch], { cwd: clean });
      execFileSync("git", ["apply", patch], { cwd: clean });
      execFileSync(process.execPath, ["--test"], { cwd: clean, stdio: "ignore" });

      // The owner's folder was only read.
      expect(git(source, "rev-parse", "HEAD")).toBe(base);
      expect(git(source, "status", "--porcelain")).toBe("");
      expect(git(source, "branch", "--format=%(refname:short)")).toBe("main");
    } finally {
      for (const child of runners)
        if (child.pid && alive(child.pid)) process.kill(child.pid, "SIGKILL");
      await server.close();
      await rm(resolve(outDir, ".."), { recursive: true, force: true });
    }
  }, 180_000);
});
