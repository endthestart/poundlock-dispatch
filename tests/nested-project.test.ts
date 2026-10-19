import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { classifyAttemptFailure, classifyLoopOutcome } from "@core/failure-class";
import { describeExclusion, excludedPath, exclusionMatch, safeReadFile } from "@core/file-access";
import type { WorkerContext } from "@core/interactive-worker";
import { buildManagerReviewPrompt } from "@core/review-context";
import { workerExecutionContext } from "@runtime/pi-worker";
import type { AttemptRecord, TaskRecord } from "@shared/types";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

/** `<lab>/.gitignore` ignores `demo/*\/`; the project lives at `<lab>/demo/local/<name>`. */
async function nestedProject(outerRules = "demo/*/\n", name = "tokenize-demo") {
  const lab = await realpath(await tempDir("dispatch-nested-"));
  await writeFile(join(lab, ".gitignore"), outerRules);
  const project = join(lab, "demo", "local", name);
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "app.txt"), "hello");
  return { lab, project };
}

function workerContext(project: string): WorkerContext {
  return {
    cwd: project,
    project: { source: { kind: "local_folder", excludedPatterns: [] } },
  } as unknown as WorkerContext;
}

describe("a project nested inside a folder an outer repository ignores", () => {
  it("still starts a worker at its own root", async () => {
    const { project } = await nestedProject();
    const ctx = await workerExecutionContext(workerContext(project));
    expect(ctx.cwd).toBe(project);
    expect(ctx.projectRoot).toBe(project);
  });

  it("does not consult .gitignore files above the project root", async () => {
    const { project } = await nestedProject();
    expect(await excludedPath(project, [], project)).toBe(false);
    expect(await excludedPath(join(project, "src", "app.txt"), [], project)).toBe(false);
    expect(await safeReadFile(project, "src/app.txt")).toBe("hello");
  });

  it("still applies the project's own .gitignore and the built-in defaults", async () => {
    const { project } = await nestedProject();
    await writeFile(join(project, ".gitignore"), "private.txt\n");
    await writeFile(join(project, "private.txt"), "mine");
    await writeFile(join(project, "src", ".env"), "SECRET=1");
    await expect(safeReadFile(project, "private.txt")).rejects.toThrow("excluded");
    await expect(safeReadFile(project, "src/.env")).rejects.toThrow("excluded");
    expect(await safeReadFile(project, "src/app.txt")).toBe("hello");
  });

  it.each([
    ["dist", ["dist", "myapp"]],
    ["target", ["target", "myapp"]],
    ["build", ["build", "myapp"]],
    ["several at once", ["build", "dist", "target", "venv", "myapp"]],
  ])("does not let a %s parent folder hide the project", async (_name, segments) => {
    // `build/`, `dist/`, `target/` and `venv/` are default exclusions, matched
    // against every suffix of the absolute path. A project that merely lives
    // under such a folder (`~/dist/myapp`) is not itself a build output.
    const lab = await realpath(await tempDir("dispatch-nested-defaults-"));
    const project = join(lab, ...segments);
    await mkdir(join(project, "src"), { recursive: true });
    await writeFile(join(project, "src", "app.txt"), "hello");
    await writeFile(join(project, "src", ".env"), "SECRET=1");
    expect((await workerExecutionContext(workerContext(project))).projectRoot).toBe(project);
    expect(await excludedPath(project, [], project)).toBe(false);
    expect(await safeReadFile(project, "src/app.txt")).toBe("hello");
    // What is excluded is still judged from the project root down.
    await expect(safeReadFile(project, "src/.env")).rejects.toThrow("excluded");
    await mkdir(join(project, "dist"));
    await writeFile(join(project, "dist", "out.js"), "built");
    await expect(safeReadFile(project, "dist/out.js")).rejects.toThrow("excluded");
  });

  it("keeps refusing a path outside the project that an enclosing .gitignore excludes", async () => {
    const { lab, project } = await nestedProject();
    const sibling = join(lab, "demo", "local", "other", "notes.txt");
    await mkdir(join(lab, "demo", "local", "other"), { recursive: true });
    await writeFile(sibling, "not this project's");
    expect(await excludedPath(sibling, [], project)).toBe(true);
  });
});

describe("naming the rule that excluded a path", () => {
  it("names the .gitignore rule and the file it is in", async () => {
    const { lab, project } = await nestedProject();
    const outside = join(lab, "demo", "local", "other", "notes.txt");
    const match = await exclusionMatch(outside, [], project);
    expect(match).toMatchObject({ rule: "demo/*/", source: join(lab, ".gitignore") });
    expect(describeExclusion(match!)).toBe(`the rule "demo/*/" in ${join(lab, ".gitignore")}`);

    await writeFile(join(project, ".gitignore"), "private.txt\n");
    expect(await exclusionMatch(join(project, "private.txt"), [], project)).toMatchObject({
      rule: "private.txt",
      source: join(project, ".gitignore"),
    });
  });

  it("names built-in and project-setting rules by where they come from", async () => {
    const { project } = await nestedProject();
    const env = await exclusionMatch(join(project, "src", ".env"), [], project);
    expect(env?.rule).toBe(".env");
    expect(describeExclusion(env!)).toContain("built-in default");
    const custom = await exclusionMatch(join(project, "src", "app.txt"), ["*.txt"], project);
    expect(custom?.rule).toBe("*.txt");
    expect(describeExclusion(custom!)).toContain("excluded patterns");
    expect(await exclusionMatch(join(project, "src", "app.txt"), [], project)).toBeUndefined();
  });

  it("agrees with excludedPath", async () => {
    const { project } = await nestedProject();
    await writeFile(join(project, ".gitignore"), "*.log\n!keep.log\n");
    for (const name of ["a.log", "keep.log", "src/app.txt", "src/.env.local", ".env.example"]) {
      const full = join(project, name);
      expect(Boolean(await exclusionMatch(full, [], project)), name).toBe(
        await excludedPath(full, [], project),
      );
    }
  });
});

describe("a worker refused for an excluded working directory", () => {
  it("says which rule and file matched, and that it is a project-setup problem", async () => {
    vi.resetModules();
    vi.doMock("@core/file-access", async (original) => ({
      ...(await original<typeof import("@core/file-access")>()),
      exclusionMatch: async () => ({
        kind: "gitignore",
        rule: "demo/*/",
        source: "/outer/.gitignore",
      }),
    }));
    try {
      const { project } = await nestedProject();
      const { workerExecutionContext: guarded } = await import("@runtime/pi-worker");
      const error = await guarded(workerContext(project)).then(
        () => undefined,
        (e: Error) => e.message,
      );
      expect(error).toContain("Working directory must be an included directory inside the project");
      expect(error).toContain('the rule "demo/*/" in /outer/.gitignore');
      expect(error).toContain(project);
      expect(error).toMatch(/project-setup problem, not a model or profile problem/);
    } finally {
      vi.doUnmock("@core/file-access");
      vi.resetModules();
    }
  });

  it("is an environment failure: free of repair and escalation, and not the model's", () => {
    const error =
      'project_setup: Working directory must be an included directory inside the project, but the rule "demo/*/" in /outer/.gitignore excludes /outer/demo/local/p.';
    expect(classifyAttemptFailure({ error })).toBe("environment");
    const attempt = { status: "failed", failureClass: "environment", error } as AttemptRecord;
    expect(classifyLoopOutcome(attempt)).toBe("free");
  });

  it("tells the manager to ask the owner, not repair, escalate or switch profiles", () => {
    const error =
      'project_setup: Working directory must be an included directory inside the project, but the rule "demo/*/" in /outer/.gitignore excludes /outer/demo/local/p.';
    const task = {
      id: "t1",
      title: "Build it",
      objective: "o",
      workerPrompt: "w",
      acceptanceCriteria: "a",
      dependsOn: [],
      difficulty: "small",
      route: "interactive",
      contextNote: "",
      status: "needs_review",
      repairCount: 0,
      attempts: [
        {
          id: "a1",
          number: 1,
          idempotencyKey: "k",
          requestHash: "h",
          profileId: "p",
          profileName: "orion",
          harnessId: "pi",
          execution: "interactive",
          status: "failed",
          failureClass: "environment",
          createdAt: new Date(0).toISOString(),
          selectionReason: "Interactive default",
          error,
        },
      ],
    } as unknown as TaskRecord;
    const packet = buildManagerReviewPrompt([task]);
    expect(packet).toMatch(/project-setup problem, not a model or profile problem/);
    expect(packet).toMatch(/ask_user/);
    expect(packet).not.toMatch(/Required action: request_repair/);
  });
});
