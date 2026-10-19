import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import {
  expectsRedTests,
  freezeAccepted,
  frozenAmong,
  frozenDrift,
  frozenNamedIn,
  frozenRefusal,
  isTestFile,
  keepFrozenCopies,
  restoreFrozenTests,
} from "@core/frozen-tests";
import { MemoryPoundlock } from "@core/memory-poundlock";
import { ProjectOrchestrator } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

describe("freezing tests", () => {
  it("keeps a copy of each frozen test and puts back only those it has", async () => {
    const root = await realpath(await tempDir("frozen-copy-"));
    const store = join(root, ".copies");
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests/test_a.py"), "assert a()\n");
    await writeFile(join(root, "tests/test_b.py"), "assert b()\n");
    const frozen = await freezeAccepted(
      [],
      { title: "Write tests", writesTests: true },
      ["tests/test_a.py", "tests/test_b.py"],
      root,
    );
    // test_b already drifted before the copy was taken, so it gets none.
    await writeFile(join(root, "tests/test_b.py"), "assert True\n");
    await keepFrozenCopies(frozen, root, store);
    await writeFile(join(root, "tests/test_a.py"), "assert True\n");
    const drifted = await frozenDrift(frozen, root);
    const restored = await restoreFrozenTests(frozen, drifted, root, store);
    expect(restored).toEqual(["tests/test_a.py"]);
    expect(await readFile(join(root, "tests/test_a.py"), "utf8")).toBe("assert a()\n");
    expect(await readFile(join(root, ".dispatch/frozen-edits/tests/test_a.py"), "utf8")).toBe(
      "assert True\n",
    );
    expect(await frozenDrift(frozen, root)).toEqual(["tests/test_b.py"]);
    expect(frozenRefusal(drifted, restored)).toMatch(
      /put tests\/test_a\.py back[\s\S]*tell the worker to restore tests\/test_b\.py exactly/,
    );
  });

  it("records an accepted test task's test files and notices any later change", async () => {
    const root = await realpath(await tempDir("frozen-"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests/test_a.py"), "assert True\n");
    await writeFile(join(root, "src.py"), "x = 1\n");
    const frozen = await freezeAccepted(
      [],
      { title: "Write tests", writesTests: true },
      ["tests/test_a.py", "src.py"],
      root,
    );
    expect(frozen.map((test) => test.path)).toEqual(["tests/test_a.py"]);
    expect(frozenAmong(frozen, ["src.py"])).toEqual([]);
    expect(frozenAmong(frozen, ["tests/test_a.py"])).toEqual(["tests/test_a.py"]);
    expect(await frozenDrift(frozen, root)).toEqual([]);
    await writeFile(join(root, "tests/test_a.py"), "assert 1\n");
    expect(await frozenDrift(frozen, root)).toEqual(["tests/test_a.py"]);
  });

  it("never freezes build output, and forgets any recorded before", async () => {
    const root = await realpath(await tempDir("frozen-"));
    const built = ".build/out/v5/units/test_entry_point.o-AZU0";
    await mkdir(join(root, ".build/out/v5/units"), { recursive: true });
    await mkdir(join(root, "Tests/ShellTests"), { recursive: true });
    await writeFile(join(root, built), "object");
    await writeFile(join(root, "Tests/ShellTests/SmokeTests.swift"), "@Test func a() {}\n");
    const stale = [{ path: built, sha256: "old", task: "Tests" }];
    expect(await frozenDrift(stale, root)).toEqual([]);
    expect(frozenAmong(stale, [built])).toEqual([]);
    const frozen = await freezeAccepted(
      stale,
      { title: "Tests", writesTests: true },
      [built, "Tests/ShellTests/SmokeTests.swift"],
      root,
    );
    expect(frozen.map((test) => test.path)).toEqual(["Tests/ShellTests/SmokeTests.swift"]);
  });

  it("freezes nothing for an ordinary task", async () => {
    const root = await realpath(await tempDir("frozen-"));
    expect(await freezeAccepted([], { title: "Build" }, ["tests/test_a.py"], root)).toEqual([]);
  });
});

describe("a later task that changes a frozen test", () => {
  it("cannot be accepted, and the manager is told why", async () => {
    const root = await realpath(await tempDir("frozen-run-"));
    const folder = join(root, "project");
    await mkdir(join(folder, "tests"), { recursive: true });
    await writeFile(join(folder, "README.md"), "app\n");
    const store = new FileStore(join(root, "data"));
    await store.init();
    await store.saveConnection({
      url: "http://fixture",
      token: "fixture",
      roles: {
        manager: { profileId: "coding", profileName: "coding", source: "interactive" },
        interactive: { profileId: "coding", profileName: "coding", source: "interactive" },
      },
    });
    const backend = new MemoryPoundlock();
    backend.listInteractiveModels = async () => [
      {
        id: "coding",
        context_tokens: 32768,
        max_output_tokens: 4096,
        dataDestination: "operator_network",
        workload_class: "interactive-coding",
      },
    ];
    const project = await createFolderProject({ store, folder });
    const refusals: string[] = [];
    const repairs: string[] = [];
    const orchestrator = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store,
      clientFor: async () => backend,
      approvals: new ApprovalBroker(),
      manager: {
        async runTurn(ctx) {
          const tasks = await store.getTasks(ctx.project.id);
          if (!tasks.length) {
            await ctx.host.proposePlan({
              summary: "Tests first",
              acceptanceCriteria: ["Tests pass"],
              tasks: [
                {
                  title: "Write tests",
                  objective: "Tests",
                  workerPrompt: "Write tests",
                  acceptanceCriteria: "Tests exist",
                  difficulty: "small",
                  route: "interactive",
                  writesTests: true,
                  filesToTouch: ["tests/test_app.py"],
                },
                {
                  title: "Implement",
                  objective: "Code",
                  workerPrompt: "Implement",
                  acceptanceCriteria: "Tests pass",
                  difficulty: "small",
                  route: "interactive",
                  filesToTouch: ["app.py"],
                },
              ],
            });
          } else {
            const review = tasks.find((task) => task.status === "needs_review");
            if (review)
              try {
                await ctx.host.requestApplyResult(review.id);
              } catch (error) {
                refusals.push(String(error));
                // A repair naming the frozen test is noted once; asking again queues it.
                for (let tries = 0; tries < 2 && repairs.length < 2; tries += 1)
                  repairs.push(
                    await ctx.host
                      .requestRepair(review.id, "Restore test_app.py exactly.")
                      .catch(String),
                  );
              }
          }
          return { text: "Recorded", toolTrace: [] };
        },
      },
      worker: {
        async run(ctx) {
          const testing = ctx.task.title === "Write tests";
          const path = testing ? "tests/test_app.py" : "app.py";
          await writeFile(
            join(ctx.cwd, path),
            testing ? "assert app() == 1\n" : "def app(): return 2\n",
          );
          // The implementation "passes" by weakening the frozen test.
          if (!testing) await writeFile(join(ctx.cwd, "tests/test_app.py"), "assert True\n");
          return {
            output: "Done",
            changedFiles: testing ? [path] : [path, "tests/test_app.py"],
            patch: "+",
            // The tests fail until the implementation exists, as they should.
            verification: testing
              ? {
                  status: "failed",
                  commands: [{ command: "pytest", exitCode: 1, output: "1 failed" }],
                }
              : { status: "passed", commands: [{ command: "pytest", exitCode: 0, output: "ok" }] },
          };
        },
      },
    });
    await orchestrator.sendMessage(project.id, "Build it");
    await orchestrator.approvePlan(project.id);
    await orchestrator.start(project.id);
    for (let step = 0; step < 6; step += 1) {
      await orchestrator.waitForLocal(project.id);
      await orchestrator.tick(project.id);
    }
    const plan = await store.getPlan(project.id);
    expect(plan?.frozenTests?.map((test) => test.path)).toEqual(["tests/test_app.py"]);
    const tasks = await store.getTasks(project.id);
    expect(tasks[0].status).toBe("applied");
    expect(tasks[1].status).not.toBe("applied");
    expect(refusals.join("\n")).toMatch(/changed frozen tests: tests\/test_app\.py/);
    expect(repairs[0]).toMatch(/names frozen tests: tests\/test_app\.py/);
    expect(repairs[1]).not.toMatch(/frozen/);
    // Dispatch put the frozen test back and kept the worker's edit beside it.
    expect(refusals[0]).toMatch(/put tests\/test_app\.py back to the frozen content/);
    expect(await readFile(join(folder, "tests/test_app.py"), "utf8")).toBe("assert app() == 1\n");
    expect(await readFile(join(folder, ".dispatch/frozen-edits/tests/test_app.py"), "utf8")).toBe(
      "assert True\n",
    );
  });
});

describe("tests written before their code", () => {
  const task = (output: string, overrides: Record<string, unknown> = {}) =>
    ({
      title: "Write tests",
      writesTests: true,
      attempts: [
        {
          status: "completed",
          result: {
            verification: {
              status: "failed",
              commands: [{ command: "cargo test", exitCode: 101, output }],
            },
          },
        },
      ],
      ...overrides,
    }) as never;

  it("are accepted red when the checks ran and test files changed", () => {
    expect(
      expectsRedTests(task("test result: FAILED. 46 passed; 3 failed"), ["tests/import.rs"]),
    ).toBe(true);
  });

  it("are not when the failure is the environment, no tests changed, or the task is not a test task", () => {
    expect(
      expectsRedTests(task("error: rustup could not choose a version of cargo to run"), [
        "tests/import.rs",
      ]),
    ).toBe(false);
    expect(expectsRedTests(task("FAILED"), ["src/import.rs"])).toBe(false);
    expect(expectsRedTests(task("FAILED", { writesTests: undefined }), ["tests/import.rs"])).toBe(
      false,
    );
  });
});

describe("a brief that names frozen tests", () => {
  it("is matched by path or file name", () => {
    const frozen = [{ path: "crates/core/tests/ffi_workflow.rs", sha256: "x", task: "t" }];
    expect(frozenNamedIn(frozen, "remove the stubs in ffi_workflow.rs")).toEqual([
      "crates/core/tests/ffi_workflow.rs",
    ]);
    expect(frozenNamedIn(frozen, "edit crates/core/tests/ffi_workflow.rs")).toHaveLength(1);
    expect(frozenNamedIn(frozen, "edit my_ffi_workflow.rs and ffi_workflow.rsx")).toEqual([]);
  });
});

describe("tests written first whose check ran none", () => {
  it("are sent back so the check runs them", async () => {
    const { buildManagerReviewPrompt } = await import("@core/review-context");
    const prompt = buildManagerReviewPrompt([
      {
        id: "t1",
        title: "Native shell contract tests",
        objective: "o",
        acceptanceCriteria: "a",
        status: "needs_review",
        writesTests: true,
        attempts: [
          {
            status: "completed",
            result: {
              changedFiles: ["Tests/ShellTests/SmokeTests.swift"],
              patches: [],
              verification: {
                status: "passed",
                commands: [
                  { command: "swift test", exitCode: 0, output: "Test run with 0 tests passed" },
                ],
              },
            },
          },
        ],
      } as never,
    ]);
    expect(prompt).toMatch(/swift test passed without running any/);
    expect(prompt).toMatch(/passed, but ran no tests/);
  });
});

describe("tests written before their code that pass", () => {
  it("are reviewed for tests that expect the code to be missing", async () => {
    const { buildManagerReviewPrompt } = await import("@core/review-context");
    const prompt = buildManagerReviewPrompt([
      {
        id: "t1",
        title: "C ABI contract tests",
        objective: "o",
        acceptanceCriteria: "a",
        status: "needs_review",
        writesTests: true,
        attempts: [
          {
            status: "completed",
            result: {
              changedFiles: ["tests/ffi.rs"],
              patches: [],
              verification: {
                status: "passed",
                commands: [{ command: "cargo test", exitCode: 0, output: "ok" }],
              },
            },
          },
        ],
      } as never,
    ]);
    expect(prompt).toMatch(/expects the code to be missing \(should_panic/);
  });
});

describe("frozen tests where the worker writes", () => {
  it("refuses the write tools and denies command writes, but leaves them readable", async () => {
    const { resolveToolPath } = await import("@runtime/path-policy");
    const { sandboxProfile } = await import("@runtime/sandbox");
    const root = await realpath(await tempDir("frozen-write-"));
    await mkdir(join(root, "tests"));
    await writeFile(join(root, "tests/test_a.py"), "assert True\n");
    const project = {
      policy: { verification: { commands: [], protectedPaths: [] } },
      source: { kind: "local_folder", excludedPatterns: [] },
    } as never;
    const ctx = { projectRoot: root, cwd: root, project, frozenPaths: ["tests/test_a.py"] };
    await expect(resolveToolPath({ ...ctx, writing: true }, "tests/test_a.py")).rejects.toThrow(
      /frozen tests/,
    );
    await expect(resolveToolPath({ ...ctx, writing: false }, "tests/test_a.py")).resolves.toBe(
      join(root, "tests/test_a.py"),
    );
    await expect(resolveToolPath({ ...ctx, writing: true }, "src.py")).resolves.toBe(
      join(root, "src.py"),
    );
    const profile = sandboxProfile({
      projectRoot: root,
      writable: [root],
      deniedRead: [],
      deniedWrite: [join(root, "tests/test_a.py")],
      network: "deny",
      tmp: "/t",
    });
    expect(profile).toContain(`(deny file-write* (literal "${join(root, "tests/test_a.py")}"))`);
  });

  it("asks a UI task's worker for headless tests and snapshots", async () => {
    const { composeWorkerInstructions, changesUi } = await import("@core/workflow-support");
    const project = { policy: { verification: { commands: [] } } } as never;
    const ui = {
      objective: "o",
      workerPrompt: "w",
      acceptanceCriteria: "a",
      filesToTouch: ["Sources/App/PhotoGrid.swift"],
    } as never;
    expect(JSON.parse(composeWorkerInstructions(ui, project)).uiEvidence).toMatch(
      /\.dispatch\/evidence\/<view>\.png/,
    );
    expect(
      changesUi({ filesToTouch: ["crates/core/src/import.rs", "Tests/AppTests/UITests.swift"] }),
    ).toBe(false);
    expect(changesUi({ filesToTouch: ["src/components/Grid.tsx"] })).toBe(true);
  });

  it("tells workers about tests-first stubs and frozen files", async () => {
    const { composeWorkerInstructions } = await import("@core/workflow-support");
    const project = { policy: { verification: { commands: [] } } } as never;
    const testTask = {
      objective: "o",
      workerPrompt: "w",
      acceptanceCriteria: "a",
      writesTests: true,
    } as never;
    expect(JSON.parse(composeWorkerInstructions(testTask, project)).testsFirst).toMatch(
      /stubs to the source files.*never mark a test as expected to fail/,
    );
    const implTask = { objective: "o", workerPrompt: "w", acceptanceCriteria: "a" } as never;
    expect(
      JSON.parse(composeWorkerInstructions(implTask, project, ["tests/test_a.py"])).frozenTests,
    ).toMatch(/never change them.*tests\/test_a\.py/);
  });
});

it("freezes files named as tests, never the helpers and fixtures beside them", () => {
  for (const path of [
    "tests/catalog.contract.test.ts",
    "tests/m1-library.spec.ts",
    "tests/test_store.py",
    "pkg/store_test.go",
    "Tests/PhotoShellTests/SmokeTests.swift",
  ])
    expect(isTestFile(path), path).toBe(true);
  for (const path of [
    "tests/helpers/generated-images.ts",
    "tests/conftest.py",
    "tests/fixtures/photo.jpg",
    "src/contest.swift",
  ])
    expect(isTestFile(path), path).toBe(false);
});
