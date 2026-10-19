import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import { MemoryPoundlock } from "@core/memory-poundlock";
import {
  addedLines,
  applyMutant,
  mutantsFromPatch,
  survivorsForWorker,
  survivorsRefusal,
} from "@core/mutation-check";
import { ProjectOrchestrator } from "@core/orchestration";
import { createFolderProject } from "@core/projects";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const patch = [
  "diff --git a/src/review.rs b/src/review.rs",
  "--- a/src/review.rs",
  "+++ b/src/review.rs",
  "@@ -1,2 +1,5 @@",
  " fn key(c: char) -> Flag {",
  '+    // picks when c == "p"',
  "+    if c == 'p' { return Flag::Pick; }",
  '+    log::info!("a < b");',
  "+    let reject = c == 'x' && true;",
  "diff --git a/tests/review.rs b/tests/review.rs",
  "--- a/tests/review.rs",
  "+++ b/tests/review.rs",
  "@@ -0,0 +1 @@",
  "+assert!(key('p') == Flag::Pick);",
].join("\n");

describe("choosing mutants", () => {
  it("numbers added lines as the file stands after the change", () => {
    expect(addedLines(patch).map((line) => [line.path, line.line])).toEqual([
      ["src/review.rs", 2],
      ["src/review.rs", 3],
      ["src/review.rs", 4],
      ["src/review.rs", 5],
      ["tests/review.rs", 1],
    ]);
  });

  it("flips conditions in source, never comments, strings, logging or tests", () => {
    const mutants = mutantsFromPatch(patch);
    expect(mutants.map((mutant) => [mutant.line, mutant.change])).toEqual([
      [3, "`==` → `!=`"],
      [5, "`==` → `!=`"],
    ]);
    expect(mutants[0].mutated).toBe("    if c != 'p' { return Flag::Pick; }");
    expect(mutantsFromPatch(patch, 1)).toHaveLength(1);
  });

  it("never mutates build output a check rebuilds", () => {
    const bundle = [
      "diff --git a/dist/client/assets/index.js b/dist/client/assets/index.js",
      "--- a/dist/client/assets/index.js",
      "+++ b/dist/client/assets/index.js",
      "@@ -0,0 +1 @@",
      "+if (a >= b) { focus(); }",
    ].join("\n");
    expect(mutantsFromPatch(bundle)).toEqual([]);
  });

  it("applies a mutant only where its line still is, or is unique", () => {
    const [mutant] = mutantsFromPatch(patch);
    const file =
      "fn key(c: char) -> Flag {\n// moved\n// down\n    if c == 'p' { return Flag::Pick; }\n";
    expect(applyMutant(file, mutant)).toContain("if c != 'p'");
    expect(applyMutant("fn other() {}\n", mutant)).toBeUndefined();
  });

  it("tells the manager which break went unnoticed and how to proceed", () => {
    const [mutant] = mutantsFromPatch(patch);
    expect(survivorsRefusal([mutant], 2)).toMatch(
      /broke this attempt's code in 2 small ways[\s\S]*src\/review\.rs:3: `==` → `!=`[\s\S]*request_repair[\s\S]*request_apply_result again/,
    );
    // An Autopilot worker has no manager to ask; with frozen tests, it adds a new file.
    const told = survivorsForWorker([mutant], 2, true);
    expect(told).not.toContain("request_repair");
    expect(told).toContain("in a new test file: tests accepted earlier are frozen");
    expect(survivorsForWorker([mutant], 2, false)).not.toContain("frozen");
  });
});

describe("the mutation check at acceptance", () => {
  async function run(options: { testCatches: boolean; mutationCheck?: boolean; saved?: boolean }) {
    const root = await realpath(await tempDir("mutation-"));
    const folder = join(root, "project");
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
    await (await import("node:fs/promises")).mkdir(folder);
    const project = await createFolderProject({ store, folder });
    if (options.saved !== false) project.policy.verification.commands = ["node --test"];
    if (options.mutationCheck !== undefined) project.policy.mutationCheck = options.mutationCheck;
    await store.saveProject(project);
    const source = "export function picks(key) {\n  return key === 'p';\n}\n";
    const verified: string[] = [];
    const replies: string[] = [];
    const orchestrator = new ProjectOrchestrator({
      hostCommands: hostCommandPort,
      store,
      clientFor: async () => backend,
      approvals: new ApprovalBroker(),
      worker: {
        async run(ctx) {
          await writeFile(join(ctx.cwd, "keys.js"), source);
          return {
            output: "Done",
            changedFiles: ["keys.js"],
            patch: `diff --git a/keys.js b/keys.js\n--- /dev/null\n+++ b/keys.js\n@@ -0,0 +1,3 @@\n${source
              .trimEnd()
              .split("\n")
              .map((line) => `+${line}`)
              .join("\n")}\n`,
            verification: {
              status: "passed",
              commands: [{ command: "node --test", exitCode: 0, output: "ok" }],
            },
          };
        },
        async verify(ctx) {
          const now = await readFile(join(ctx.cwd, "keys.js"), "utf8");
          verified.push(now);
          const broken = now.includes("!==");
          return options.testCatches && broken
            ? {
                status: "failed",
                commands: [{ command: "node --test", exitCode: 1, output: "1 failed" }],
              }
            : {
                status: "passed",
                commands: [{ command: "node --test", exitCode: 0, output: "ok" }],
              };
        },
      },
      manager: {
        async runTurn(ctx) {
          const tasks = await store.getTasks(ctx.project.id);
          if (!tasks.length)
            await ctx.host.proposePlan({
              summary: "Keys",
              acceptanceCriteria: ["P picks"],
              tasks: [
                {
                  title: "Keys",
                  objective: "P picks",
                  workerPrompt: "Map P to pick",
                  acceptanceCriteria: "Pressing P marks the photo picked",
                  difficulty: "small",
                  route: "interactive",
                  filesToTouch: ["keys.js"],
                },
              ],
            });
          else if (tasks[0].status === "needs_review")
            replies.push(await ctx.host.requestApplyResult(tasks[0].id).catch(String));
          return { text: "Recorded", toolTrace: [] };
        },
      },
    });
    await orchestrator.sendMessage(project.id, "Build it");
    await orchestrator.approvePlan(project.id);
    await orchestrator.start(project.id);
    await orchestrator.waitForLocal(project.id);
    await orchestrator.tick(project.id);
    const [task] = await store.getTasks(project.id);
    return { task, verified, replies, folder, source, store, project, orchestrator };
  }

  it("accepts work whose checks catch a break, and leaves the code as the worker wrote it", async () => {
    const { task, verified, replies, folder, source } = await run({ testCatches: true });
    expect(verified).toEqual(["export function picks(key) {\n  return key !== 'p';\n}\n"]);
    expect(task.status).toBe("applied");
    expect(task.attempts.at(-1)?.mutation?.mutants).toEqual([
      { path: "keys.js", line: 2, change: "`===` → `!==`", caught: true },
    ]);
    expect(replies[0]).toMatch(/accepted/);
    expect(await readFile(join(folder, "keys.js"), "utf8")).toBe(source);
  });

  it("refuses once when no check notices, then accepts on the manager's next call", async () => {
    const { replies, folder, source, store, project } = await run({ testCatches: false });
    expect(replies[0]).toMatch(/Mutation check[\s\S]*keys\.js:2: `===` → `!==`/);
    expect(replies[1]).toMatch(/accepted/);
    expect(await readFile(join(folder, "keys.js"), "utf8")).toBe(source);
    expect(
      (await store.getMessages(project.id)).some((m) =>
        /Mutation check on “Keys”: 0 of 1 small breaks caught[\s\S]*Not caught: keys\.js:2/.test(
          m.text,
        ),
      ),
    ).toBe(true);
    const [task] = await store.getTasks(project.id);
    expect(task.status).toBe("applied");
    expect(task.attempts.at(-1)?.mutation?.mutants[0]?.caught).toBe(false);
  });

  it("runs on the checks Dispatch found when the project saved none", async () => {
    const { task, verified } = await run({ testCatches: true, saved: false });
    expect(verified).toHaveLength(1);
    expect(task.status).toBe("applied");
  });

  it("puts a broken line back when Dispatch stopped mid-check", async () => {
    const { folder, source, store, project, orchestrator } = await run({
      testCatches: true,
      mutationCheck: false,
    });
    const path = join(folder, "keys.js");
    const dir = join(store.layout.root, "projects", project.id, "mutation");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pending.json"), JSON.stringify({ path, original: source }));
    await writeFile(path, source.replace("===", "!=="));
    await orchestrator.recover(project.id);
    expect(await readFile(path, "utf8")).toBe(source);
    expect(
      (await store.getMessages(project.id)).some((m) =>
        /stopped during a mutation check and has put .*keys\.js back/.test(m.text),
      ),
    ).toBe(true);
  });

  it("is skipped when the project turns it off", async () => {
    const { task, verified } = await run({ testCatches: false, mutationCheck: false });
    expect(verified).toEqual([]);
    expect(task.status).toBe("applied");
  });
});
