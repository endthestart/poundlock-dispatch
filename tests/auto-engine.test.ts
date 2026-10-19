import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkpointsSince,
  createRunWorktree,
  ensureMirror,
  exportPatch,
  RunRepo,
  resetToCheckpoint,
  saveDraft,
} from "@core/auto/checkpoint-git";
import {
  type AutoRunDeps,
  AutoRunEngine,
  failingLine,
  failureReason,
  namedFiles,
} from "@core/auto/engine";
import { IsolationUnavailableError } from "@core/auto/isolation";
import { AutoLedger } from "@core/auto/ledger";
import type {
  AutoPreparePort,
  AutoVerifierPort,
  AutoWorkerPort,
  CaseAttemptInput,
  CaseAttemptResult,
} from "@core/auto/ports";
import {
  type AutoCase,
  type AutoLimits,
  autoProgressView,
  DEFAULT_AUTO_LIMITS,
  unfinishedLine,
} from "@shared/auto-run";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

async function setup(files: Record<string, string> = {}) {
  const source = await tempDir("auto-source-");
  git(source, "init", "-q", "-b", "main");
  await writeFile(join(source, ".gitignore"), ".venv/\n");
  await writeFile(join(source, "README.md"), "base\n");
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(source, name, ".."), { recursive: true });
    await writeFile(join(source, name), text);
  }
  git(source, "add", "-A");
  git(source, "commit", "-q", "-m", "base");
  const base = git(source, "rev-parse", "HEAD");
  const root = await tempDir("auto-data-");
  const runsRoot = join(root, "runs");
  const runDir = join(runsRoot, "r1");
  await mkdir(runDir, { recursive: true });
  const mirror = await ensureMirror(source, join(root, "mirrors", "m.git"), base);
  const repo = await createRunWorktree(mirror, join(runDir, "work"), "auto/r1", base);
  return {
    source,
    base,
    mirror,
    repo,
    runsRoot,
    runDir,
    worktree: repo.worktree,
    ledger: new AutoLedger(runDir),
  };
}
type Env = Awaited<ReturnType<typeof setup>>;

type Script = (input: CaseAttemptInput) => Promise<CaseAttemptResult>;

function worker(script: Script, seen: CaseAttemptInput[] = []): AutoWorkerPort {
  return {
    runCase: async (input) => {
      seen.push(input);
      return script(input);
    },
  };
}

/** Passes when no *.txt file at the top of the worktree contains "BUG". */
const verifier: AutoVerifierPort = {
  async verify(worktree) {
    const bad = readdirSync(worktree)
      .filter((f) => f.endsWith(".txt"))
      .filter((f) =>
        execFileSync("cat", [join(worktree, f)])
          .toString()
          .includes("BUG"),
      );
    return {
      passed: bad.length === 0,
      commands: [
        {
          command: "check",
          exitCode: bad.length ? 1 : 0,
          output: bad.length ? `error: BUG in ${bad.join(",")}` : "ok",
        },
      ],
    };
  },
};

const limits: AutoLimits = { ...DEFAULT_AUTO_LIMITS, caseMinutes: 60 };
const cases: AutoCase[] = [
  {
    id: "C1",
    title: "first",
    objective: "write c1.txt",
    acceptanceCriteria: "c1.txt exists",
    dependsOn: [],
  },
  {
    id: "C2",
    title: "second",
    objective: "write c2.txt",
    acceptanceCriteria: "c2.txt exists",
    dependsOn: ["C1"],
  },
];

function engine(env: Env, w: AutoWorkerPort, extra: Partial<AutoRunDeps> = {}) {
  return new AutoRunEngine({
    runId: "r1",
    ledger: env.ledger,
    worker: w,
    verifier,
    repo: env.repo,
    mirror: env.mirror,
    runsRoot: env.runsRoot,
    controlPollMs: 20,
    scope: { bookkeeping: ["NOTES.md"] },
    ...extra,
  });
}

const write = (dir: string, name: string, text: string) => writeFile(join(dir, name), text);
const spec = (list = cases) => ({ cases: list, limits, model: "orion" });

describe("auto engine", () => {
  it("lets a case change only the frozen tests the Planner named, and records why", async () => {
    const env = await setup();
    const planned: AutoCase[] = [
      { ...cases[0], id: "T1", title: "tests", objective: "write tests", writesTests: true },
      {
        ...cases[1],
        id: "T2",
        dependsOn: ["T1"],
        frozenTestsToChange: ["test_raw.txt"],
        frozenChangeReason: "RAW files are now stored as placeholders",
      },
    ];
    await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "T1") {
          await write(i.worktree, "test_raw.txt", "assert raw rejected\n");
          await write(i.worktree, "test_other.txt", "assert other\n");
        } else {
          await write(i.worktree, "c2.txt", "ok\n");
          await write(i.worktree, "test_raw.txt", "assert raw stored\n");
        }
        return { finish: "done", summary: "done" };
      }),
    ).start(spec(planned));
    const state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
    expect(state.frozenChanges).toEqual([
      { caseId: "T2", paths: ["test_raw.txt"], reason: "RAW files are now stored as placeholders" },
    ]);
  });

  it("asks the Planner about frozen tests a case failed on, and lets later cases change them", async () => {
    const env = await setup();
    await write(env.worktree, "test_schema.txt", "one migration\n");
    await write(env.worktree, "test_routes.txt", "two routes\n");
    git(env.worktree, "add", "test_schema.txt", "test_routes.txt");
    git(env.worktree, "commit", "-qm", "frozen schema test");
    // The frozen test pins one migration: any case that adds one fails it.
    const schemaVerifier: AutoVerifierPort = {
      async verify(worktree) {
        const pinned =
          readFileSync(join(worktree, "test_schema.txt"), "utf8") === "one migration\n";
        const added = existsSync(join(worktree, "c1.txt")) || existsSync(join(worktree, "c2.txt"));
        const failing = pinned && added;
        return {
          passed: !failing,
          commands: [
            {
              command: "npm test",
              exitCode: failing ? 1 : 0,
              output: failing
                ? "FAIL test_schema.txt > applies one migration\nFAIL test_routes.txt > lists two routes"
                : "ok",
            },
          ],
        };
      },
    };
    const asked: string[][] = [];
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "migration\n");
        if (i.case.frozenTestsToChange?.includes("test_schema.txt"))
          await write(i.worktree, "test_schema.txt", "migrations apply once\n");
        return { finish: "done", summary: "added a migration" };
      }),
      {
        verifier: schemaVerifier,
        frozenTests: ["test_schema.txt", "test_routes.txt"],
        onFrozenBlocked: async (input) => {
          asked.push(input.tests);
          return [
            { path: "test_schema.txt", reason: "it pins one migration; M2 adds tables" },
            { path: "test_routes.txt", reason: "it pins the route list" },
          ];
        },
      },
    ).start(spec([cases[0], { ...cases[1], dependsOn: [] }]));
    const state = await env.ledger.state();
    expect(asked).toEqual([["test_schema.txt", "test_routes.txt"]]);
    expect(state.cases.map((c) => c.stage)).toEqual(["abandoned", "accepted"]);
    expect(state.frozenChanges).toEqual([
      {
        caseId: "C2",
        paths: ["test_schema.txt"],
        reason: "test_schema.txt: it pins one migration; M2 adds tables",
      },
    ]);
  });

  it("takes a blocked claim that names a frozen test to the Planner, and goes on when it allows it", async () => {
    const env = await setup();
    await write(env.worktree, "test_shape.txt", "metadata without labels\n");
    git(env.worktree, "add", "test_shape.txt");
    git(env.worktree, "commit", "-qm", "frozen shape test");
    const asked: string[][] = [];
    await engine(
      env,
      worker(async (i) => {
        if (!i.case.frozenTestsToChange?.includes("test_shape.txt"))
          return {
            finish: "blocked",
            blockedReason: "Frozen test test_shape.txt asserts the metadata shape without labels",
          };
        await write(i.worktree, "c1.txt", "labels\n");
        await write(i.worktree, "test_shape.txt", "metadata with labels\n");
        return { finish: "done", summary: "added labels" };
      }),
      {
        frozenTests: ["test_shape.txt"],
        onFrozenBlocked: async (input) => {
          asked.push(input.tests);
          return [{ path: "test_shape.txt", reason: "it pins the metadata shape labels extend" }];
        },
      },
    ).start(spec([cases[0]]));
    const state = await env.ledger.state();
    expect(asked).toEqual([["test_shape.txt"]]);
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted"]);
    expect(state.frozenChanges?.[0]?.paths).toEqual(["test_shape.txt"]);
  });

  it("runs the checks again when only an untouched frozen test failed, and records it", async () => {
    const env = await setup();
    await write(env.worktree, "test_token.txt", "wrong token\n");
    git(env.worktree, "add", "test_token.txt");
    git(env.worktree, "commit", "-qm", "frozen token test");
    let runs = 0;
    // A frozen test that fails at random: the first run after the change fails.
    const flaky: AutoVerifierPort = {
      async verify() {
        runs++;
        const failing = runs === 2;
        return {
          passed: !failing,
          commands: [
            {
              command: "npm test",
              exitCode: failing ? 1 : 0,
              output: failing ? "FAIL test_token.txt > rejects a wrong token" : "ok",
            },
          ],
        };
      },
    };
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", "ok\n");
        return { finish: "done", summary: "done" };
      }),
      { verifier: flaky, frozenTests: ["test_token.txt"] },
    ).start(spec([cases[0]]));
    const state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted"]);
    const reruns = (await env.ledger.read()).flatMap((e) =>
      e.event.type === "checks_rerun" ? [e.event] : [],
    );
    expect(reruns).toMatchObject([{ caseId: "C1", tests: ["test_token.txt"], passed: true }]);
  });

  it("tells a worker blocked by a frozen test it may already change that it may", async () => {
    const env = await setup();
    await write(env.worktree, "test_api.txt", "two methods\n");
    git(env.worktree, "add", "test_api.txt");
    git(env.worktree, "commit", "-qm", "frozen api test");
    const told: string[] = [];
    await engine(
      env,
      worker(async (i) => {
        if (!i.repairFindings?.includes("You may change test_api.txt"))
          return {
            finish: "blocked",
            blockedReason: "The criteria ask me to edit test_api.txt, which another task owns",
          };
        told.push(i.repairFindings);
        await write(i.worktree, "c1.txt", "wired\n");
        await write(i.worktree, "test_api.txt", "three methods\n");
        return { finish: "done", summary: "wired" };
      }),
      { frozenTests: ["test_api.txt"] },
    ).start(
      spec([
        {
          ...cases[0],
          frozenTestsToChange: ["test_api.txt"],
          frozenChangeReason: "it pins the old method list",
        },
      ]),
    );
    expect(told[0]).toContain("although other tasks wrote them");
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted"]);
  });

  it("still refuses a frozen test the Planner did not name", async () => {
    const env = await setup();
    const planned: AutoCase[] = [
      { ...cases[0], id: "T1", title: "tests", objective: "write tests", writesTests: true },
      { ...cases[1], id: "T2", dependsOn: ["T1"], frozenTestsToChange: ["test_raw.txt"] },
    ];
    await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "T1") {
          await write(i.worktree, "test_raw.txt", "assert raw rejected\n");
          await write(i.worktree, "test_other.txt", "assert other\n");
        } else {
          await write(i.worktree, "c2.txt", "ok\n");
          await write(i.worktree, "test_other.txt", "assert True\n");
        }
        return { finish: "done", summary: "done" };
      }),
    ).start(spec(planned));
    const scope = (await env.ledger.read()).flatMap((e) =>
      e.event.type === "scope" ? e.event.violations : [],
    );
    expect(scope).toContain("test_other.txt (frozen test)");
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted", "abandoned"]);
  });

  it("freezes a tests-first case's tests and refuses a later case that changes them", async () => {
    const env = await setup();
    const testsFirst: AutoCase[] = [
      { ...cases[0], id: "T1", title: "tests", objective: "write test_t1.txt", writesTests: true },
      { ...cases[1], id: "T2", dependsOn: ["T1"] },
    ];
    await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "T1") await write(i.worktree, "test_t1.txt", "assert works\n");
        else {
          await write(i.worktree, "c2.txt", "ok\n");
          await write(i.worktree, "test_t1.txt", "assert True\n");
        }
        return { finish: "done", summary: "done" };
      }),
    ).start(spec(testsFirst));
    const entries = await env.ledger.read();
    expect(entries.find((e) => e.event.type === "frozen")?.event).toMatchObject({
      caseId: "T1",
      paths: ["test_t1.txt"],
    });
    const scope = entries.flatMap((e) => (e.event.type === "scope" ? e.event.violations : []));
    expect(scope).toContain("test_t1.txt (frozen test)");
    const state = await env.ledger.state();
    expect(state.cases.map((c) => [c.id, c.stage])).toEqual([
      ["T1", "accepted"],
      ["T2", "abandoned"],
    ]);
  });

  it("mutation-checks a task that freezes its tests, since it builds code too", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(
          i.worktree,
          "keys.js",
          "export function picks(key) {\n  return key === 'p';\n}\n",
        );
        await write(i.worktree, "test_keys.txt", "assert picks\n");
        return { finish: "done", summary: "wrote keys and its test" };
      }),
      { mutationCheck: true },
    ).start(spec([{ ...cases[0], writesTests: true }]));
    expect(outcome).toBe("objective_met");
    const mutation = (await env.ledger.read()).find((e) => e.event.type === "mutation")?.event;
    expect(mutation).toMatchObject({ caseId: "C1", mutants: [{ path: "keys.js", line: 2 }] });
  });

  it("sends a case back once when its checks miss a deliberate break, then accepts", async () => {
    const env = await setup();
    const seen: CaseAttemptInput[] = [];
    const code = "export function picks(key) {\n  return key === 'p';\n}\n";
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "keys.js", code);
        return { finish: "done", summary: "wrote keys" };
      }, seen),
      { mutationCheck: true },
    ).start(spec([cases[0]]));
    expect(outcome).toBe("objective_met");
    expect(seen).toHaveLength(2);
    expect(seen[1].repairFindings).toMatch(/Mutation check[\s\S]*keys\.js:2: `===` → `!==`/);
    const mutation = (await env.ledger.read()).find((e) => e.event.type === "mutation")?.event;
    expect(mutation).toMatchObject({
      caseId: "C1",
      mutants: [{ path: "keys.js", line: 2, caught: false }],
    });
    // The code is back as the worker wrote it.
    expect(await readFile(join(env.worktree, "keys.js"), "utf8")).toBe(code);
  });

  it("never reads or rewrites a file outside the worktree through a link the worker left", async () => {
    const env = await setup();
    const outside = join(await tempDir("auto-outside-"), "secret.js");
    const secret = "export function same(a, b) {\n  if (a === b) return 1;\n  return 0;\n}\n";
    await writeFile(outside, secret);
    const seen: CaseAttemptInput[] = [];
    const outcome = await engine(
      env,
      worker(async (i) => {
        await symlink(outside, join(i.worktree, "leak.js"));
        await write(i.worktree, "c1.txt", "ok\n");
        return { finish: "done", summary: "done" };
      }, seen),
      { mutationCheck: true },
    ).start(spec([cases[0]]));
    // The link itself is refused: it would point the owner's folder outside the project.
    expect(outcome).not.toBe("objective_met");
    expect(await readFile(outside, "utf8")).toBe(secret);
    const scope = (await env.ledger.read()).find((e) => e.event.type === "scope")?.event;
    expect(scope).toMatchObject({ violations: ["leak.js (a link out of the project)"] });
    const mutation = (await env.ledger.read()).find((e) => e.event.type === "mutation")?.event;
    expect(JSON.stringify(mutation ?? {})).not.toContain("leak.js");
    expect(seen.every((input) => !input.repairFindings?.includes("a === b"))).toBe(true);
  });

  it("takes inbox entries once: Pause stops after the case, a message is recorded, resume goes on", async () => {
    const env = await setup();
    const run = (posted: boolean) =>
      engine(
        env,
        worker(async (i) => {
          if (i.case.id === "C1" && posted) {
            await env.ledger.postInbox("message", "Prefer small files.");
            await env.ledger.postInbox("pause");
          }
          await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
          return { finish: "done", summary: "wrote it" };
        }),
      );
    expect(await run(true).start(spec())).toBe("cancelled_after_checkpoint");
    let state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "pending"]);
    expect(state.ownerMessages?.map((m) => m.text)).toEqual(["Prefer small files."]);
    // The same inbox entries are not taken again on resume.
    expect(await run(false).resume()).toBe("objective_met");
    state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
    expect((await env.ledger.read()).filter((e) => e.event.type === "inbox")).toHaveLength(2);
  });

  it("works cases that join the board during the run, and refuses ones that depend on nothing known", async () => {
    const env = await setup();
    let offered = 0;
    const added: AutoCase = {
      id: "C3",
      title: "third",
      objective: "write c3.txt",
      acceptanceCriteria: "c3.txt exists",
      dependsOn: ["C1"],
    };
    const broken: AutoCase = { ...added, id: "C4", dependsOn: ["NOPE"] };
    const seen: CaseAttemptInput[] = [];
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done", summary: "wrote it" };
      }, seen),
      {
        newCases: async () => {
          offered += 1;
          return offered === 2 ? [added, broken] : offered === 3 ? [added] : [];
        },
      },
    ).start(spec());
    expect(outcome).toBe("objective_met");
    expect(seen.map((i) => i.case.id)).toEqual(["C1", "C2", "C3"]);
    const state = await env.ledger.state();
    expect(state.cases.map((c) => [c.id, c.stage])).toEqual([
      ["C1", "accepted"],
      ["C2", "accepted"],
      ["C3", "accepted"],
    ]);
    // Replaying the ledger knows the added case.
    const events = (await env.ledger.read()).filter((e) => e.event.type === "cases_added");
    expect(events).toHaveLength(1);
  });

  it("accepts verified cases as checkpoint commits and never touches the source checkout", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return {
          finish: "done",
          summary: "wrote it",
          usage: { input: 10, output: 5, cacheWrite: 0, cacheRead: 1000 },
        };
      }),
    ).start(spec());
    expect(outcome).toBe("objective_met");
    expect(git(env.worktree, "log", "--format=%s", "-3").split("\n")).toEqual([
      "auto: C2 second",
      "auto: C1 first",
      "base",
    ]);
    const body = git(env.worktree, "log", "-1", "--format=%b");
    expect(body).toContain("Verified, not reviewed");
    expect(body).toContain("Dispatch-Auto-Case: C2");
    expect(body).toContain("Dispatch-Auto-Review: none");
    expect(git(env.source, "log", "--format=%s")).toBe("base");
    expect(git(env.source, "branch", "--list")).toBe("* main");
    const state = await env.ledger.state();
    expect(state.usage.cacheRead).toBe(2000);
    expect(state.substantiveAccepted).toBe(2);
    expect(state.preflight).toBe("passed");
    expect(autoProgressView(state, new Date()).join("\n")).toContain(
      "30 processed tokens (2k cache reads not counted)",
    );
  });

  it("repairs in the same session with the failing check's output, then accepts", async () => {
    const env = await setup();
    const seen: CaseAttemptInput[] = [];
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", i.attempt === 1 ? "BUG\n" : "fixed\n");
        return { finish: "done" };
      }, seen),
    ).start(spec([cases[0]]));
    expect(seen.map((s) => [s.attempt, s.sessionKey, s.fresh])).toEqual([
      [1, "C1-session", true],
      [2, "C1-session", false],
    ]);
    expect(seen[1].repairFindings).toContain("BUG in c1.txt");
    expect((await env.ledger.state()).cases[0].stage).toBe("accepted");
  });

  it("does not accept a claimed success that fails the checks", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", "BUG\n");
        return { finish: "done", summary: "All checks pass!" };
      }),
    ).start(spec());
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["abandoned", "skipped"]);
    expect(outcome).toBe("failed");
    expect(git(env.worktree, "log", "--format=%s")).toBe("base");
  });

  it("reports accepted work when a later case is abandoned and nothing else can run", async () => {
    const env = await setup();
    const three = [...cases, { ...cases[1], id: "C3", title: "third", dependsOn: ["C2"] }];
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(
          i.worktree,
          `${i.case.id.toLowerCase()}.txt`,
          i.case.id === "C2" ? "BUG\n" : "ok\n",
        );
        return { finish: "done" };
      }),
    ).start(spec(three));
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual([
      "accepted",
      "abandoned",
      "skipped",
    ]);
    expect(outcome).toBe("limit_reached_with_accepted_work");
  });

  it("keeps every failed attempt as a draft that restores byte for byte", async () => {
    const env = await setup();
    const bytes = Buffer.from([0, 255, 1, 254, 0, 10]);
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", `BUG attempt ${i.attempt}\n`);
        await writeFile(join(i.worktree, "blob.bin"), bytes);
        await write(i.worktree, "run.sh", "#!/bin/sh\n");
        await chmod(join(i.worktree, "run.sh"), 0o755);
        return { finish: "done" };
      }),
    ).start(spec([cases[0]]));
    const refs = (
      await env.repo.output(["for-each-ref", "--format=%(refname)", "refs/auto/r1/drafts"])
    ).split("\n");
    // Two attempts failing the same way end the case.
    expect(refs.length).toBeGreaterThanOrEqual(2);
    // After abandoning, the worktree is back at the checkpoint...
    expect(existsSync(join(env.worktree, "c1.txt"))).toBe(false);
    // ...and the last attempt restores exactly from its draft.
    const restored = join(env.runsRoot, "restore");
    await env.mirror.output([
      "worktree",
      "add",
      "-q",
      "--detach",
      restored,
      refs.find((r) => r.endsWith("-2-attempt"))!,
    ]);
    expect(await readFile(join(restored, "c1.txt"), "utf8")).toBe("BUG attempt 2\n");
    expect(await readFile(join(restored, "blob.bin"))).toEqual(bytes);
    expect(git(restored, "ls-files", "-s", "run.sh").startsWith("100755")).toBe(true);
    const patches = readdirSync(join(env.runDir, "drafts")).filter((f) => f.endsWith(".patch"));
    expect(patches.length).toBe(refs.length);
  });

  it("saves verified progress that was not declared finished, and continues", async () => {
    const env = await setup();
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `part${i.attempt}.txt`, "ok\n");
        return { finish: i.attempt === 1 ? "none" : "done" };
      }),
    ).start(spec([cases[0]]));
    expect(git(env.worktree, "log", "--format=%s").split("\n")).toEqual([
      "auto: C1 first",
      "auto: C1 (progress) first",
      "base",
    ]);
  });

  it("marks a blocked case and skips its dependents", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async () => ({ finish: "blocked", blockedReason: "needs a credential" })),
    ).start(spec());
    expect((await env.ledger.state()).cases.map((c) => [c.stage, c.reason])).toEqual([
      ["blocked", "needs a credential"],
      ["skipped", "depends on C1, which did not finish"],
    ]);
    expect(outcome).toBe("blocked_for_input");
  });

  it("puts a first blocked claim back to the worker, which then finishes", async () => {
    const env = await setup();
    const seen: CaseAttemptInput[] = [];
    const outcome = await engine(
      env,
      worker(async (i) => {
        if (i.attempt === 1) return { finish: "blocked", blockedReason: "turn limit reached" };
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }, seen),
    ).start(spec([cases[0]]));
    expect(outcome).toBe("objective_met");
    expect(seen[1].repairFindings).toContain(
      'You reported this case blocked: "turn limit reached"',
    );
  });

  it("treats changes outside the writable paths as a scope failure, the case's own paths first", async () => {
    const env = await setup();
    const seen: CaseAttemptInput[] = [];
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, i.attempt === 1 ? "outside.txt" : "src-c1.txt", "ok\n");
        if (i.attempt === 2) await rm(join(i.worktree, "outside.txt"), { force: true });
        return { finish: "done" };
      }, seen),
      { scope: { writable: ["docs"] } },
    ).start(spec([{ ...cases[0], writable: ["src-c1.txt"] }]));
    expect(seen[1].repairFindings).toContain("outside.txt");
    expect((await env.ledger.state()).cases[0].stage).toBe("accepted");
  });

  it("never counts or commits tool caches, and puts a tracked cache file back", async () => {
    const env = await setup({ "app/__pycache__/tracked.pyc": "old\n" });
    const outcome = await engine(
      env,
      worker(async (i) => {
        await mkdir(join(i.worktree, "src", "__pycache__"), { recursive: true });
        await write(join(i.worktree, "src", "__pycache__"), "c1.cpython-312.pyc", "x");
        await mkdir(join(i.worktree, "node_modules", ".cache"), { recursive: true });
        await write(join(i.worktree, "node_modules", ".cache"), "state.json", "{}");
        await write(join(i.worktree, "app", "__pycache__"), "tracked.pyc", "new\n");
        await mkdir(join(i.worktree, "src"), { recursive: true });
        await write(join(i.worktree, "src"), "c1.py", "print(1)\n");
        return { finish: "done" };
      }),
      { scope: { writable: ["src/"] } },
    ).start(spec([cases[0]]));
    expect(outcome).toBe("objective_met");
    expect(git(env.worktree, "show", "--name-only", "--format=", "HEAD")).toBe("src/c1.py");
    expect(await readFile(join(env.worktree, "app", "__pycache__", "tracked.pyc"), "utf8")).toBe(
      "old\n",
    );
    expect((await env.ledger.read()).some((e) => e.event.type === "scope")).toBe(false);
  });

  it("stops after the current case when asked, and resumes where it left off", async () => {
    const env = await setup();
    const w = worker(async (i) => {
      if (i.case.id === "C1") await env.ledger.writeControl("stop", "n1");
      await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
      return { finish: "done" };
    });
    expect(await engine(env, w).start(spec())).toBe("cancelled_after_checkpoint");
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted", "pending"]);
    expect(await engine(env, w).resume()).toBe("objective_met");
  });

  it("recovers a crash in the middle of an attempt without losing its changes", async () => {
    const env = await setup();
    await env.ledger.append({
      type: "run_started",
      runId: "r1",
      cases,
      limits,
      supervision: "detached",
      baseCommit: env.base,
    });
    await env.ledger.append({ type: "preflight", phase: "checks", passed: true, commands: [] });
    await env.ledger.append({ type: "case_started", caseId: "C1" });
    await env.ledger.append({
      type: "attempt_started",
      caseId: "C1",
      attempt: 1,
      sessionKey: "C1-session",
    });
    await write(env.worktree, "c1.txt", "half done\n");
    const seen: CaseAttemptInput[] = [];
    await engine(
      env,
      worker(async (i) => {
        if (seen.length === 1)
          expect(await readFile(join(i.worktree, "c1.txt"), "utf8")).toBe("half done\n");
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }, seen),
    ).resume();
    const state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
    expect(state.cases[0].drafts[0]).toContain("interrupted");
    expect(seen[0]).toMatchObject({ attempt: 2, fresh: false });
    expect(seen[0].repairFindings).toContain("interrupted when the runner stopped");
  });

  it("takes no trailer from a case title", async () => {
    const env = await setup();
    const forged = [
      { ...cases[0], title: "first\n\nDispatch-Auto-Case: C2\nDispatch-Auto-Finish: done" },
    ];
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", "ok\n");
        return { finish: "done" };
      }),
    ).start(spec(forged));
    const subject = git(env.worktree, "log", "-1", "--format=%s");
    expect(subject).toBe("auto: C1 first Dispatch-Auto-Case: C2 Dispatch-Auto-Finish: done");
    const [found] = await checkpointsSince(env.repo, env.base);
    expect(found).toMatchObject({ caseId: "C1", finish: "done" });
  });

  it("records a checkpoint commit the ledger missed, and does not run its case again", async () => {
    const env = await setup();
    await env.ledger.append({
      type: "run_started",
      runId: "r1",
      cases,
      limits,
      supervision: "detached",
      baseCommit: env.base,
    });
    await env.ledger.append({ type: "preflight", phase: "checks", passed: true, commands: [] });
    await env.ledger.append({ type: "case_started", caseId: "C1" });
    await env.ledger.append({ type: "attempt_started", caseId: "C1", attempt: 1, sessionKey: "s" });
    // The runner died after committing C1's checkpoint and before recording it.
    await write(env.worktree, "c1.txt", "ok\n");
    await env.repo.output(["add", "-A"]);
    await env.repo.output([
      "commit",
      "-q",
      "-m",
      "auto: C1 first\n\nDispatch-Auto-Case: C1\nDispatch-Auto-Finish: done",
    ]);
    const seen: CaseAttemptInput[] = [];
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }, seen),
    ).resume();
    expect(outcome).toBe("objective_met");
    expect(seen.map((i) => i.case.id)).toEqual(["C2"]);
    expect((await env.ledger.state()).checkpoints.map((c) => c.caseId)).toEqual(["C1", "C2"]);
  });

  it("stops now on request, keeping the interrupted attempt's work", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", "half\n");
        await env.ledger.writeControl("stop_now", "n1");
        await new Promise<void>((done) => i.signal.addEventListener("abort", () => done()));
        return { finish: "none", error: "Worker interrupted." };
      }),
    ).start(spec());
    expect(outcome).toBe("cancelled_after_checkpoint");
    const state = await env.ledger.state();
    expect(state.cases[0].drafts).toHaveLength(1);
    expect(await readFile(join(env.worktree, "c1.txt"), "utf8")).toBe("half\n");
    expect(state.endReason).toBe("stopped by the owner");
  });

  it("stops now during the checks too, deciding nothing on checks cut short", async () => {
    const env = await setup();
    let calls = 0;
    const slow: AutoVerifierPort = {
      async verify(worktree, signal) {
        calls++;
        if (calls === 1) return verifier.verify(worktree, signal);
        await env.ledger.writeControl("stop_now", "n2");
        await new Promise<void>((done) => signal.addEventListener("abort", () => done()));
        return {
          passed: false,
          commands: [{ command: "check", exitCode: null, output: "Cancelled" }],
        };
      },
    };
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", "ok\n");
        return { finish: "done" };
      }),
      { verifier: slow },
    ).start(spec());
    expect(outcome).toBe("cancelled_after_checkpoint");
    const events = (await env.ledger.read()).map((e) => e.event.type);
    expect(events.filter((e) => e === "verification")).toEqual([]);
    expect(events.includes("case_repair")).toBe(false);
    expect((await env.ledger.state()).cases[0].stage).toBe("running");
  });

  it("starts no new case after a soft limit, and keeps what was verified", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
    ).start({ ...spec(), limits: { ...limits, maxCases: 1 } });
    expect(outcome).toBe("limit_reached_with_accepted_work");
    const state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "pending"]);
    expect(state.limitsHit).toEqual([{ kind: "cases", level: "soft" }]);
  });

  it("finishes a case that was under way when a resumed run is already at a soft limit", async () => {
    const env = await setup();
    const one = { ...limits, maxCases: 1 };
    await env.ledger.append({
      type: "run_started",
      runId: "r1",
      cases,
      limits: one,
      supervision: "detached",
      baseCommit: env.base,
    });
    await env.ledger.append({ type: "preflight", phase: "checks", passed: true, commands: [] });
    await env.ledger.append({ type: "case_started", caseId: "C1" });
    await env.ledger.append({ type: "attempt_started", caseId: "C1", attempt: 1, sessionKey: "s" });
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
    ).resume();
    expect(outcome).toBe("limit_reached_with_accepted_work");
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted", "pending"]);
  });

  it("accepts a finished case whose acceptance the ledger missed, without running it again", async () => {
    const env = await setup();
    await env.ledger.append({
      type: "run_started",
      runId: "r1",
      cases,
      limits,
      supervision: "detached",
      baseCommit: env.base,
    });
    await env.ledger.append({ type: "preflight", phase: "checks", passed: true, commands: [] });
    await env.ledger.append({ type: "case_started", caseId: "C1" });
    await write(env.worktree, "c1.txt", "ok\n");
    await env.repo.output(["add", "-A"]);
    await env.repo.output([
      "commit",
      "-q",
      "-m",
      "auto: C1 first\n\nDispatch-Auto-Case: C1\nDispatch-Auto-Finish: done",
    ]);
    await env.ledger.append({
      type: "checkpoint",
      caseId: "C1",
      commit: await env.repo.head(),
      substantive: true,
      reviewed: false,
    });
    const seen: CaseAttemptInput[] = [];
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }, seen),
    ).resume();
    expect(seen.map((i) => i.case.id)).toEqual(["C2"]);
  });

  it("stops at the hard limit without resetting the worktree", async () => {
    const env = await setup();
    let now = new Date("2026-09-26T00:00:00Z");
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "c1.txt", "BUG\n");
        now = new Date(now.getTime() + 26 * 3_600_000);
        return { finish: "done" };
      }),
      { clock: () => now, ledger: new AutoLedger(env.runDir, () => now) },
    ).start(spec());
    expect(outcome).toBe("limit_reached_without_accepted_work");
    expect(await readFile(join(env.worktree, "c1.txt"), "utf8")).toBe("BUG\n");
    expect((await env.ledger.state()).cases[0].drafts.length).toBe(1);
  });

  it("accepts a later 'done' with nothing new only when this run already checkpointed the case", async () => {
    const env = await setup();
    const outcome = await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "C1" && i.attempt === 1) {
          await write(i.worktree, "c1.txt", "ok\n");
          return { finish: "partial" };
        }
        return { finish: "done" }; // C1 attempt 2 and C2: no changes
      }),
    ).start(spec());
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted", "abandoned"]);
    expect(outcome).toBe("limit_reached_with_accepted_work");
  });

  it("with the setting on, accepts an idle 'done' once challenged, as already met", async () => {
    const env = await setup();
    await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "C1" && i.attempt === 1) {
          await write(i.worktree, "c1.txt", "ok\n");
          return { finish: "partial" };
        }
        return { finish: "done" }; // C1 attempt 2 and C2: no changes
      }),
      { acceptsAlreadyMet: true },
    ).start(spec());
    const events = (await env.ledger.read()).map((e) => e.event);
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
    expect(
      events.flatMap((e) => (e.type === "case_accepted" ? [[e.caseId, e.after]] : [])),
    ).toEqual([
      ["C1", "checkpoint"],
      ["C2", "already_met"],
    ]);
    // C1 kept a checkpoint and is taken at once; C2 is put back once first.
    expect(
      events.flatMap((e) => (e.type === "case_repair" && e.caseId === "C2" ? [e.reason] : [])),
    ).toEqual(["done with no changes, challenged"]);
  });

  it("asks once, writes blocked, whether verified work cut off by the case time is complete", async () => {
    for (const answer of ["done", "partial"] as const) {
      const env = await setup();
      let now = new Date("2026-09-26T00:00:00Z");
      const seen: CaseAttemptInput[] = [];
      const outcome = await engine(
        env,
        worker(async (i) => {
          if (i.finalize) return { finish: answer };
          await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
          if (i.case.id === "C1") now = new Date(now.getTime() + 61 * 60_000);
          return { finish: i.case.id === "C1" ? "none" : "done", error: "Worker interrupted." };
        }, seen),
        { clock: () => now, ledger: new AutoLedger(env.runDir, () => now) },
      ).start(spec());
      const state = await env.ledger.state();
      expect(seen.filter((i) => i.finalize).map((i) => i.case.id)).toEqual(["C1"]);
      if (answer === "done") {
        expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
        expect(outcome).toBe("objective_met");
      } else {
        expect(state.cases.map((c) => c.stage)).toEqual(["abandoned", "skipped"]);
        // The verified work stays on the run branch as a progress checkpoint.
        expect(git(env.worktree, "log", "--format=%s", "-1")).toContain("(progress)");
      }
    }
  });

  it("gives a case back the time its worker waited for a busy model", async () => {
    const env = await setup();
    const waiting = worker(async (i) => {
      // The case has 300 ms; its clock stops while the model is busy.
      i.onCapacityWait?.(true);
      await new Promise((resolve) => setTimeout(resolve, 600));
      i.onCapacityWait?.(false);
      if (i.signal.aborted) return { finish: "none", error: String(i.signal.reason) };
      await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
      return { finish: "done" };
    });
    const quick = { cases, limits: { ...limits, caseMinutes: 0.005 }, model: "orion" };
    expect(await engine(env, waiting).start(quick)).toBe("objective_met");
  });

  it("runs the case clock again once the model is free", async () => {
    const env = await setup();
    let aborted = false;
    const w = worker(async (i) => {
      i.onCapacityWait?.(true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      i.onCapacityWait?.(false);
      await new Promise((resolve) => setTimeout(resolve, 900));
      aborted = i.signal.aborted;
      return { finish: "none", error: String(i.signal.reason) };
    });
    const quick = { cases, limits: { ...limits, caseMinutes: 0.005 }, model: "orion" };
    await engine(env, w).start(quick);
    expect(aborted).toBe(true);
  });

  it("keeps the worker's last report with a case that ran out of time", async () => {
    const env = await setup();
    const w = worker(async (i) => {
      await new Promise((resolve) => setTimeout(resolve, 900));
      return {
        finish: "none",
        error: String(i.signal.reason),
        summary: "StrictMode double-mounts the grid, which drops the focus",
      };
    });
    const quick = { cases, limits: { ...limits, caseMinutes: 0.005 }, model: "orion" };
    await engine(env, w).start(quick);
    const abandoned = (await env.ledger.state()).cases.find((c) => c.stage === "abandoned");
    expect(unfinishedLine("Grid", abandoned!)).toBe(
      "Grid (abandoned: case allowance of 0.005 min used) The worker's last report: StrictMode double-mounts the grid, which drops the focus",
    );
  });

  it("waits out a busy model however long it takes", async () => {
    const env = await setup();
    let calls = 0;
    const busy = worker(async (i) => {
      calls++;
      if (calls <= 4)
        return {
          finish: "none",
          error: "Poundlock capacity_in_use wait exhausted.",
          inferenceUnavailable: true,
          capacityBusy: true,
        };
      await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
      return { finish: "done" };
    });
    expect(await engine(env, busy, { inferenceWaitsMs: [1] }).start(spec())).toBe("objective_met");
    const state = await env.ledger.state();
    expect(state.cases.map((c) => c.repairs)).toEqual([0, 0]);
  });

  it("waits for Poundlock without counting a repair, then ends the run ready to resume", async () => {
    const env = await setup();
    let calls = 0;
    const seen: CaseAttemptInput[] = [];
    const flaky = worker(async (i) => {
      calls++;
      if (calls <= 2) {
        await write(i.worktree, "c1.txt", `ok ${calls}\n`);
        return { finish: "none", error: "fetch failed", inferenceUnavailable: true };
      }
      await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
      return { finish: "done" };
    }, seen);
    expect(await engine(env, flaky, { inferenceWaitsMs: [1] }).start(spec())).toBe(
      "blocked_for_input",
    );
    let state = await env.ledger.state();
    expect(state.endReason).toContain("stayed unavailable (fetch failed)");
    expect(state.cases[0]).toMatchObject({ stage: "running", repairs: 0 });
    expect(await readFile(join(env.worktree, "c1.txt"), "utf8")).toBe("ok 2\n");
    expect(seen[1].repairFindings).toContain("could not be reached");
    expect(await engine(env, flaky, { inferenceWaitsMs: [1] }).resume()).toBe("objective_met");
    state = await env.ledger.state();
    expect(state.cases.map((c) => c.repairs)).toEqual([0, 0]);
  });
});

describe("auto engine and the container runtime", () => {
  const passingWorker = worker(async (i) => {
    await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
    return { finish: "done" };
  });
  const flakyVerifier = (failures: number): AutoVerifierPort => {
    let calls = 0;
    return {
      async verify(worktree, signal) {
        calls++;
        // The base check is the first call; the runtime goes down after it.
        if (calls > 1 && calls <= 1 + failures)
          throw new IsolationUnavailableError("Cannot connect to the Docker daemon");
        return verifier.verify(worktree, signal);
      },
    };
  };

  it("waits out a container runtime outage without counting a repair", async () => {
    const env = await setup();
    const outcome = await engine(env, passingWorker, {
      verifier: flakyVerifier(2),
      inferenceWaitsMs: [1, 1, 1],
    }).start(spec([cases[0]]));
    expect(outcome).toBe("objective_met");
    const events = (await env.ledger.read()).map((e) => e.event);
    expect(events.filter((e) => e.type === "inference_wait")).toMatchObject([
      { on: "container" },
      { on: "container" },
    ]);
    expect(events.some((e) => e.type === "case_repair")).toBe(false);
  });

  it("ends the run ready to resume when the runtime stays down", async () => {
    const env = await setup();
    const outcome = await engine(env, passingWorker, {
      verifier: flakyVerifier(10),
      inferenceWaitsMs: [1],
    }).start(spec([cases[0]]));
    expect(outcome).toBe("blocked_for_input");
    const state = await env.ledger.state();
    expect(state.endReason).toContain("container runtime stayed unavailable");
    expect(state.cases[0].stage).toBe("running");
    expect(await readFile(join(env.worktree, "c1.txt"), "utf8")).toBe("ok\n");
  });
});

describe("auto preflight", () => {
  const passing = worker(async (i) => {
    await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
    return { finish: "done" };
  });

  it("starts no case when the plan's checks fail at the base commit", async () => {
    const env = await setup({ "base.txt": "BUG\n" });
    const seen: CaseAttemptInput[] = [];
    const outcome = await engine(
      env,
      worker(async () => ({ finish: "done" }), seen),
    ).start(spec());
    expect(outcome).toBe("blocked_for_input");
    expect(seen).toEqual([]);
    const state = await env.ledger.state();
    expect(state.preflight).toBe("failed");
    expect(state.endReason).toContain(
      "the plan's checks fail at the base commit: `check` exited 1",
    );
    expect(await readFile(join(env.runDir, "verify", "preflight-checks.log"), "utf8")).toContain(
      "BUG in base.txt",
    );
  });

  it("refuses a base whose checks change tracked files", async () => {
    const env = await setup();
    const dirtying: AutoVerifierPort = {
      async verify(worktree) {
        await write(worktree, "README.md", "rewritten by the checks\n");
        return { passed: true, commands: [{ command: "fmt", exitCode: 0, output: "" }] };
      },
    };
    expect(await engine(env, passing, { verifier: dirtying }).start(spec())).toBe(
      "blocked_for_input",
    );
    expect((await env.ledger.state()).endReason).toContain(
      "change tracked files at the base commit: README.md",
    );
  });

  it("keeps what setup creates out of scope and out of every commit", async () => {
    const env = await setup();
    const preparer: AutoPreparePort = {
      async prepare() {
        await mkdir(join(env.worktree, "env", "bin"), { recursive: true });
        await write(join(env.worktree, "env", "bin"), "python", "#!/bin/sh\n");
        return { passed: true, commands: [{ command: "make-env", exitCode: 0, output: "made" }] };
      },
    };
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, scope: { writable: ["c1.txt", "c2.txt"] } },
    ).start(spec());
    expect(outcome).toBe("objective_met");
    const state = await env.ledger.state();
    expect(state.environmentPaths).toEqual(["env"]);
    expect(
      git(env.worktree, "log", "--name-only", "--format=", `${env.base}..HEAD`)
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual(["c1.txt", "c2.txt"]);
  });

  it("clears an earlier run's environment exclusions when a run starts", async () => {
    const env = await setup();
    // An earlier run on this mirror took c1.txt for its environment.
    await writeFile(join(env.mirror.dir, "info", "exclude"), ".DS_Store\n/c1.txt\n/node_modules\n");
    const preparer: AutoPreparePort = {
      async prepare() {
        await mkdir(join(env.worktree, "env"), { recursive: true });
        await write(join(env.worktree, "env"), "lib.js", "x\n");
        return { passed: true, commands: [{ command: "make-env", exitCode: 0, output: "made" }] };
      },
    };
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, scope: { writable: ["c1.txt", "c2.txt"] } },
    ).start(spec());
    expect(outcome).toBe("objective_met");
    expect((await env.ledger.state()).environmentPaths).toEqual(["env"]);
    const committed = git(env.worktree, "log", "--name-only", "--format=", `${env.base}..HEAD`);
    expect(committed).toContain("c1.txt");
    expect(await readFile(join(env.mirror.dir, "info", "exclude"), "utf8")).not.toContain(
      "/node_modules",
    );
  });

  it("hands failing checks at the start to a goal's Planner instead of ending the run", async () => {
    const env = await setup();
    await write(env.worktree, "base.txt", "BUG\n");
    git(env.worktree, "add", "base.txt");
    git(env.worktree, "commit", "-qm", "broken base");
    let seen: string | undefined;
    const outcome = await engine(
      env,
      worker(async () => ({ finish: "done" })),
      {
        repairsBase: true,
        whenIdle: async (state) => {
          seen = state.baseFailing;
          return { end: { outcome: "blocked_for_input", reason: "planned the repair" } };
        },
      },
    ).start(spec());
    expect(outcome).toBe("blocked_for_input");
    expect(seen).toMatch(/^check: /);
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["skipped", "skipped"]);
    // A resume does not run the base checks again: the start already handed them on.
    const checksRuns = async () =>
      (await env.ledger.read()).filter(
        (e) => e.event.type === "preflight" && e.event.phase === "checks",
      ).length;
    const before = await checksRuns();
    await engine(
      env,
      worker(async () => ({ finish: "done" })),
      {
        repairsBase: true,
        whenIdle: async () => ({ end: { outcome: "blocked_for_input", reason: "still planning" } }),
      },
    ).resume();
    expect(await checksRuns()).toBe(before);
  });

  it("puts a finish back once when it left the files the task names alone", async () => {
    const env = await setup({ "src/main.tsx": "app\n", "src/shell.tsx": "shell\n" });
    const wire: AutoCase = {
      id: "W1",
      title: "Wire the panel into main.tsx",
      objective: "Pass the client to the shell in main.tsx so the panel shows in the real app",
      acceptanceCriteria: "main.tsx passes the client; a test in shell.test.tsx proves it",
      dependsOn: [],
    };
    const told: string[] = [];
    await engine(
      env,
      worker(async (i) => {
        if (i.repairFindings) told.push(i.repairFindings);
        await write(
          join(i.worktree, "src"),
          told.length ? "main.tsx" : "shell.tsx",
          told.length ? "app with panel\n" : "shell takes a client\n",
        );
        return { finish: "done" };
      }),
    ).start(spec([wire]));
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted"]);
    expect(told[0]).toContain("The task names src/main.tsx");
    const repairs = (await env.ledger.read()).flatMap((e) =>
      e.event.type === "case_repair" ? [e.event.reason] : [],
    );
    expect(repairs).toEqual(["named files untouched: src/main.tsx"]);
    const committed = git(env.worktree, "log", "--name-only", "--format=", `${env.base}..HEAD`);
    expect(committed).toContain("src/main.tsx");
    expect(committed).toContain("src/shell.tsx");
  });

  it("asks about named files only once, then takes the worker's word", async () => {
    const env = await setup({ "src/main.tsx": "app\n", "src/shell.tsx": "shell\n" });
    const wire: AutoCase = {
      id: "W1",
      title: "Wire the panel into main.tsx",
      objective: "Pass the client to the shell",
      acceptanceCriteria: "main.tsx passes the client",
      dependsOn: [],
    };
    let attempts = 0;
    await engine(
      env,
      worker(async (i) => {
        attempts++;
        await write(join(i.worktree, "src"), "shell.tsx", `shell ${attempts}\n`);
        return { finish: "done", summary: "main.tsx already passes every client" };
      }),
    ).start(spec([wire]));
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted"]);
    expect(attempts).toBe(2);
  });

  it("with the setting on, takes a second 'done' that changed nothing as already met", async () => {
    const env = await setup();
    const seen: CaseAttemptInput[] = [];
    await engine(
      env,
      worker(async () => ({ finish: "done", summary: "test_a.txt already checks this" }), seen),
      { acceptsAlreadyMet: true },
    ).start(spec([cases[0]]));
    const events = (await env.ledger.read()).map((e) => e.event);
    expect((await env.ledger.state()).cases.map((c) => c.stage)).toEqual(["accepted"]);
    expect(events.filter((e) => e.type === "case_repair").map((e) => e.reason)).toEqual([
      "done with no changes, challenged",
    ]);
    expect(events.find((e) => e.type === "case_accepted")).toMatchObject({ after: "already_met" });
    expect(seen[1]?.repairFindings).toContain("name, in your summary, the tests that show it");
  });

  it("with the setting on, shows a case the existing tests it names before its first attempt", async () => {
    const env = await setup({ "tests/e2e/stacks.spec.ts": "stack test\n" });
    const seen: CaseAttemptInput[] = [];
    const e2e: AutoCase = {
      id: "E1",
      title: "E2E test: stacks",
      objective: "Cover stacking in a real browser",
      acceptanceCriteria: "stacks.spec.ts creates, expands and unstacks a stack",
      dependsOn: [],
    };
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "e1.txt", "ok\n");
        return { finish: "done" };
      }, seen),
      { acceptsAlreadyMet: true },
    ).start(spec([e2e]));
    expect(seen[0]?.repairFindings).toContain("tests/e2e/stacks.spec.ts already exists");
  });

  it("names a file only when one tracked file matches and it is not a test", () => {
    const tracked = [
      "src/clients/main.tsx",
      "src/clients/LibraryShell.test.tsx",
      "src/a/index.ts",
      "src/b/index.ts",
      "src/server/app.ts",
    ];
    expect(
      namedFiles(
        "Wire into main.tsx and server/app.ts; see LibraryShell.test.tsx and index.ts; add new.tsx",
        tracked,
      ),
    ).toEqual(["src/clients/main.tsx", "src/server/app.ts"]);
  });

  it("runs the base checks again when only a frozen test failed at the start", async () => {
    const env = await setup();
    await write(env.worktree, "test_token.txt", "token\n");
    git(env.worktree, "add", "test_token.txt");
    git(env.worktree, "commit", "-qm", "frozen token test");
    let runs = 0;
    const flaky: AutoVerifierPort = {
      async verify() {
        const failing = ++runs === 1;
        return {
          passed: !failing,
          commands: [
            {
              command: "npm test",
              exitCode: failing ? 1 : 0,
              output: failing ? "× test_token.txt > rejects a wrong token" : "ok",
            },
          ],
        };
      },
    };
    let seen: string | undefined = "not idle";
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      {
        verifier: flaky,
        frozenTests: ["test_token.txt"],
        repairsBase: true,
        whenIdle: async (state) => {
          seen = state.baseFailing;
          return { end: { outcome: "objective_met", reason: "done" } };
        },
      },
    ).start(spec());
    const events = (await env.ledger.read()).map((e) => e.event);
    expect(events.find((e) => e.type === "checks_rerun")).toMatchObject({
      tests: ["test_token.txt"],
      passed: true,
    });
    expect(events.find((e) => e.type === "preflight" && e.phase === "checks")).toMatchObject({
      passed: true,
    });
    expect(seen).toBeUndefined();
  });

  it("rebuilds a changed environment from setup when downloads are approved", async () => {
    const env = await setup();
    const preparer: AutoPreparePort = {
      async prepare() {
        await mkdir(join(env.worktree, "env", "bin"), { recursive: true });
        await write(join(env.worktree, "env", "bin"), "pytest", "#!/bin/sh\nrun-tests\n");
        return { passed: true, commands: [{ command: "make-env", exitCode: 0, output: "made" }] };
      },
    };
    const outcome = await engine(
      env,
      worker(async (i) => {
        // Patch the test runner: Dispatch rebuilds it before the checks run.
        await write(join(i.worktree, "env", "bin"), "pytest", "#!/bin/sh\nexit 0\n");
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, installsDependencies: true, scope: { writable: ["c1.txt", "c2.txt"] } },
    ).start(spec());
    expect(outcome).toBe("objective_met");
    const restored = (await env.ledger.read()).find((e) => e.event.type === "environment_restored");
    expect(restored?.event).toMatchObject({
      caseId: "C1",
      paths: ["env/bin/pytest"],
      passed: true,
    });
    expect(await readFile(join(env.worktree, "env", "bin", "pytest"), "utf8")).toBe(
      "#!/bin/sh\nrun-tests\n",
    );
  });

  it("refuses a case that changes what setup prepared (L32)", async () => {
    const env = await setup();
    const preparer: AutoPreparePort = {
      async prepare() {
        await mkdir(join(env.worktree, "env", "bin"), { recursive: true });
        await write(join(env.worktree, "env", "bin"), "pytest", "#!/bin/sh\nrun-tests\n");
        return { passed: true, commands: [{ command: "make-env", exitCode: 0, output: "made" }] };
      },
    };
    const outcome = await engine(
      env,
      worker(async (i) => {
        // Doctor the test runner so the checks pass whatever the code does.
        await write(join(i.worktree, "env", "bin"), "pytest", "#!/bin/sh\nexit 0\n");
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, scope: { writable: ["c1.txt", "c2.txt"] } },
    ).start(spec());
    expect(outcome).not.toBe("objective_met");
    const events = (await readFile(join(env.ledger.runDir, "events.jsonl"), "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line).event);
    expect(
      events.some(
        (event) =>
          event.type === "scope" &&
          event.violations.includes("env/bin/pytest (prepared environment)"),
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "case_accepted")).toBe(false);
  });

  it("clears what a case added to the environment before its checks, without refusing it", async () => {
    const env = await setup();
    const preparer: AutoPreparePort = {
      async prepare() {
        await mkdir(join(env.worktree, "env", "bin"), { recursive: true });
        await write(join(env.worktree, "env", "bin"), "pytest", "#!/bin/sh\nrun-tests\n");
        return { passed: true, commands: [{ command: "make-env", exitCode: 0, output: "made" }] };
      },
    };
    const independent = cases.map((item) => ({ ...item, dependsOn: [] }));
    const outcome = await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "C1") {
          // Scratch scripts in the environment: removed before the checks, with a note.
          await mkdir(join(i.worktree, "env", ".scratch"), { recursive: true });
          await write(join(i.worktree, "env", ".scratch"), "check.js", "x\n");
        }
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, scope: { writable: ["c1.txt", "c2.txt"] } },
    ).start(spec(independent));
    const state = await env.ledger.state();
    expect(state.cases.map((c) => c.stage)).toEqual(["accepted", "accepted"]);
    expect(outcome).toBe("objective_met");
    const cleaned = (await env.ledger.read()).find((e) => e.event.type === "environment_cleaned");
    expect(cleaned?.event).toMatchObject({ caseId: "C1", paths: ["env/.scratch/check.js"] });
    expect(existsSync(join(env.worktree, "env", ".scratch", "check.js"))).toBe(false);
  });

  it("runs setup again mid-case for new dependencies, and takes the new environment as given", async () => {
    const env = await setup();
    let runs = 0;
    const preparer: AutoPreparePort = {
      async prepare() {
        runs++;
        // Setup installs whatever the manifest names, as npm install would.
        const wanted = existsSync(join(env.worktree, "deps.txt"))
          ? readFileSync(join(env.worktree, "deps.txt"), "utf8")
          : "";
        await mkdir(join(env.worktree, "modules"), { recursive: true });
        await write(join(env.worktree, "modules"), "installed", wanted || "nothing\n");
        if (wanted) await write(env.worktree, "deps.lock", `locked ${wanted}`);
        return {
          passed: true,
          commands: [{ command: "install", exitCode: 0, output: "installed" }],
        };
      },
    };
    const outcome = await engine(
      env,
      worker(async (i) => {
        if (i.case.id === "C1") {
          await write(i.worktree, "deps.txt", "left-pad\n");
          const result = await i.installDependencies!(i.signal);
          expect(result.passed).toBe(true);
        }
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, installsDependencies: true },
    ).start(spec());
    expect(outcome).toBe("objective_met");
    expect(runs).toBe(2);
    const state = await env.ledger.state();
    expect(state.environmentPaths).toEqual(["modules"]);
    // The manifest is the case's change; what setup made is not.
    expect(
      git(env.worktree, "log", "--name-only", "--format=", `${env.base}..HEAD`)
        .split("\n")
        .filter(Boolean)
        .sort(),
    ).toEqual(["c1.txt", "c2.txt", "deps.lock", "deps.txt"]);
  });

  it("will not reinstall over a changed environment, which would hide the change", async () => {
    const env = await setup();
    let runs = 0;
    const preparer: AutoPreparePort = {
      async prepare() {
        runs++;
        await mkdir(join(env.worktree, "modules"), { recursive: true });
        await write(join(env.worktree, "modules"), "runner.js", "real\n");
        return { passed: true, commands: [{ command: "install", exitCode: 0, output: "ok" }] };
      },
    };
    let refused = "";
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(join(i.worktree, "modules"), "runner.js", "always passes\n");
        refused = (await i.installDependencies!(i.signal)).commands[0].output;
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { preparer, installsDependencies: true },
    ).start(spec([cases[0]]));
    expect(refused).toContain("Refused: these files of the prepared environment were changed");
    // The start's setup, then the rebuild after the attempt: never a reinstall over the change.
    expect(runs).toBe(2);
    const restored = (await env.ledger.read()).find((e) => e.event.type === "environment_restored");
    expect(restored?.event).toMatchObject({ caseId: "C1", passed: true });
  });

  it("tells a worker its test run ran no tests, rather than that it did not finish", async () => {
    const env = await setup();
    const vacuous: AutoVerifierPort = {
      async verify(worktree) {
        const tested = existsSync(join(worktree, "c1.test.txt"));
        return {
          passed: tested,
          commands: [
            tested
              ? { command: "npm test", exitCode: 0, output: "1 passed" }
              : {
                  command: "npm test",
                  exitCode: 0,
                  output: "No test files found",
                  error: "The test command ran no tests, so it verified nothing. Add tests.",
                },
          ],
        };
      },
    };
    const seen: CaseAttemptInput[] = [];
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, i.attempt === 1 ? "c1.txt" : "c1.test.txt", "ok\n");
        return { finish: "done" };
      }, seen),
      { verifier: vacuous, greenfield: true },
    ).start(spec([cases[0]]));
    expect(seen[1].repairFindings).toContain(
      "Command `npm test` exited 0, but: The test command ran no tests",
    );
  });

  it("skips the base checks of a greenfield goal, and still checks every case", async () => {
    const env = await setup({ "base.txt": "BUG\n" });
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, "base.txt", "fixed\n");
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
      { greenfield: true },
    ).start(spec());
    expect(outcome).toBe("objective_met");
    const state = await env.ledger.state();
    expect(state.preflight).toBe("passed");
    expect(existsSync(join(env.runDir, "verify", "preflight-checks.log"))).toBe(false);
  });

  it("stops before any case when setup fails", async () => {
    const env = await setup();
    const preparer: AutoPreparePort = {
      prepare: async () => ({
        passed: false,
        commands: [{ command: "uv sync", exitCode: 2, output: "no network" }],
      }),
    };
    expect(await engine(env, passing, { preparer }).start(spec())).toBe("blocked_for_input");
    expect((await env.ledger.state()).endReason).toContain("setup failed: `uv sync` exited 2");
  });
});

describe("auto git", () => {
  it("never follows a .git file the worktree's owner rewrote", async () => {
    const env = await setup();
    await writeFile(join(env.worktree, ".git"), "gitdir: /nonexistent/evil\n");
    const outcome = await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        return { finish: "done" };
      }),
    ).start(spec());
    expect(outcome).toBe("objective_met");
    expect(await env.mirror.output(["log", "--format=%s", "-1", "auto/r1"])).toBe(
      "auto: C2 second",
    );
  });

  it("ignores the owner's global Git configuration, and exports non-UTF-8 bytes exactly", async () => {
    const env = await setup();
    const home = await tempDir("auto-home-");
    await writeFile(join(home, "ignore"), "*.txt\n");
    await writeFile(
      join(home, ".gitconfig"),
      `[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n[diff]\n\tnoprefix = true\n\texternal = /nonexistent/diff\n[color]\n\tui = always\n[core]\n\texcludesFile = ${join(home, "ignore")}\n`,
    );
    const latin1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]);
    const saved = process.env.HOME;
    process.env.HOME = home;
    let exported: Awaited<ReturnType<typeof exportPatch>>;
    try {
      const outcome = await engine(
        env,
        worker(async (i) => {
          await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
          await writeFile(join(i.worktree, "latin1.dat"), latin1);
          return { finish: "done" };
        }),
      ).start(spec());
      expect(outcome).toBe("objective_met");
      exported = await exportPatch(
        env.mirror,
        env.base,
        await env.repo.head(),
        join(env.runDir, "export", "r1.patch"),
        ["verified, not reviewed"],
      );
    } finally {
      process.env.HOME = saved;
    }
    const clean = await tempDir("auto-clean-bytes-");
    git(clean, "clone", "-q", env.source, "c");
    execFileSync("git", ["apply", exported.file], { cwd: join(clean, "c") });
    expect(await readFile(join(clean, "c", "latin1.dat"))).toEqual(latin1);
    expect(await readFile(join(clean, "c", "c2.txt"), "utf8")).toBe("ok\n");
  });

  it("never commits or runs Git inside a repository nested in the worktree", async () => {
    const env = await setup();
    const marker = join(await tempDir("auto-marker-"), "ran");
    const seen: CaseAttemptInput[] = [];
    const outcome = await engine(
      env,
      worker(async (i) => {
        const sub = join(i.worktree, "sub");
        if (i.attempt === 1) {
          await mkdir(sub, { recursive: true });
          git(sub, "init", "-q");
          await write(sub, "f", "a\n");
          git(sub, "add", "f");
          git(sub, "commit", "-q", "-m", "x");
          git(sub, "config", "filter.x.clean", `touch ${marker}`);
          await write(sub, ".gitattributes", "f filter=x\n");
          await write(sub, "f", "b\n");
          await mkdir(join(i.worktree, "empty"), { recursive: true });
          git(join(i.worktree, "empty"), "init", "-q");
        } else {
          await rm(sub, { recursive: true, force: true });
          await rm(join(i.worktree, "empty"), { recursive: true, force: true });
        }
        await write(i.worktree, "c1.txt", "ok\n");
        return { finish: "done" };
      }, seen),
    ).start(spec([cases[0]]));
    expect(outcome).toBe("objective_met");
    expect(seen[1].repairFindings).toContain("Git repositories inside the project");
    expect(seen[1].repairFindings).toContain("sub");
    expect((await env.ledger.state()).cases[0].drafts.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(marker)).toBe(false);
    expect(git(env.worktree, "show", "--name-only", "--format=", "HEAD")).toBe("c1.txt");
  });

  it("refuses to reset anything outside the runs folder", async () => {
    const env = await setup();
    const elsewhere = new RunRepo(env.source, join(env.source, ".git"));
    await expect(
      resetToCheckpoint(elsewhere, "HEAD", { mirrorDir: env.mirror.dir, runsRoot: env.runsRoot }),
    ).rejects.toThrow(/not inside the auto runs folder/);
  });

  it("returns no draft when nothing changed", async () => {
    const env = await setup();
    expect(
      await saveDraft(env.repo, "refs/auto/r1/drafts/x", join(env.runDir, "x.patch"), "x"),
    ).toBeNull();
  });

  it("exports a patch that applies to the base in a clean clone, saying it is not reviewed", async () => {
    const env = await setup();
    await expect(
      exportPatch(env.mirror, env.base, env.base, join(env.runDir, "none.patch"), ["x"]),
    ).rejects.toThrow(/no verified change/);
    await engine(
      env,
      worker(async (i) => {
        await write(i.worktree, `${i.case.id.toLowerCase()}.txt`, "ok\n");
        await writeFile(join(i.worktree, "blob.bin"), Buffer.from([0, 1, 2, 255]));
        return { finish: "done" };
      }),
    ).start(spec());
    const head = await env.repo.head();
    const exported = await exportPatch(
      env.mirror,
      env.base,
      head,
      join(env.runDir, "export", "r1.patch"),
      ["Dispatch auto run r1: verified, not reviewed.", "", "Review it before you apply it."],
    );
    expect(exported.files.sort()).toEqual(["blob.bin", "c1.txt", "c2.txt"]);
    const text = await readFile(exported.file, "utf8");
    expect(text.startsWith("# Dispatch auto run r1: verified, not reviewed.\n#\n# Review it")).toBe(
      true,
    );
    const clean = await tempDir("auto-clean-");
    git(clean, "clone", "-q", env.source, "c");
    execFileSync("git", ["apply", "--check", exported.file], { cwd: join(clean, "c") });
    execFileSync("git", ["apply", exported.file], { cwd: join(clean, "c") });
    expect(await readFile(join(clean, "c", "blob.bin"))).toEqual(Buffer.from([0, 1, 2, 255]));
  });
});

describe("failingLine", () => {
  it("names the failing test, not a passing test's stderr", () => {
    const output = [
      "stderr | tests/web/import-dialog.test.tsx > import dialog: out-of-root path fails with an actionable reason (R5)",
      "✓ tests/web/import-dialog.test.tsx (6 tests)",
      "FAIL  tests/web/folder-panel.test.tsx > folder panel > renames a folder",
      "AssertionError: expected 'Raw' to be 'Raw 2024'",
    ].join("\n");
    expect(failingLine(output)).toBe(
      "FAIL  tests/web/folder-panel.test.tsx > folder panel > renames a folder",
    );
  });

  it("falls back to any line that mentions a failure", () => {
    expect(failingLine("ok\nbuild failed with 2 problems")).toBe("build failed with 2 problems");
  });
});

describe("failureReason", () => {
  it("tells a worker that changed a frozen test to put new tests in a new file", () => {
    const reason = failureReason(
      { finish: "done" },
      { passed: true, commands: [] },
      ["src/clients/LibraryGrid.test.tsx (frozen test)"],
      false,
    );
    expect(reason.details).toContain("put new tests in a new test file");
  });

  it("names a frozen test the failure is in, so the Planner can allow or avoid it", () => {
    const reason = failureReason(
      { finish: "done" },
      {
        passed: false,
        commands: [
          {
            command: "npm test",
            exitCode: 1,
            output:
              "✓ src/a.test.ts (3 tests)\nFAIL  src/server/ui-routes.test.ts > serves the assets\nAssertionError: bytes differ",
          },
        ],
      },
      [],
      false,
      new Set(["src/server/ui-routes.test.ts", "src/a.test.ts"]),
    );
    expect(reason.signature).toContain("[frozen test failing: src/server/ui-routes.test.ts]");
  });
});
