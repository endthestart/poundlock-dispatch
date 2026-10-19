/**
 * L28: a case may not change what runs on the owner's machine once the patch
 * is applied unless the plan names it, and export lists every such file.
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AutoLedger } from "@core/auto/ledger";
import { AutoPaths, exportRun } from "@core/auto/runs";
import { runsOnHost, scopeViolations } from "@core/auto/scope";
import { startAutoRun } from "@core/auto/start";
import { afterAll, describe, expect, it } from "vitest";
import { fakeDocker } from "./support/fake-docker";
import { fakePoundlock } from "./support/fake-poundlock";
import { tempDir } from "./support/temp-dir";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd })
    .toString()
    .trim();

const servers: Array<{ close(): Promise<void> }> = [];
afterAll(async () => {
  for (const server of servers) await server.close();
});

const HOST = [
  ".husky/pre-commit",
  ".githooks/pre-push",
  ".pre-commit-config.yaml",
  ".envrc",
  ".vscode/tasks.json",
  ".devcontainer/devcontainer.json",
  ".claude/settings.json",
  ".pi/extensions/x.ts",
  "AGENTS.md",
  "packages/web/AGENTS.md",
  "CLAUDE.md",
];

describe("files that run on the owner's machine", () => {
  it("are recognised wherever they sit", () => {
    for (const path of HOST) expect(runsOnHost(path), path).toBe(true);
    for (const path of ["src/app.ts", "README.md", "docs/husky.md", "package.json"])
      expect(runsOnHost(path), path).toBe(false);
  });

  it("are out of scope unless the plan names them, even with everything writable", () => {
    const changed = [...HOST, "src/app.ts"];
    expect(scopeViolations(changed, {})).toEqual(HOST);
    expect(scopeViolations(changed, { writable: ["."] })).toEqual(HOST);
    expect(scopeViolations(changed, { writable: ["src"] })).toEqual(HOST);
    expect(scopeViolations([".husky/pre-commit", "AGENTS.md"], {}, [".husky", "src"])).toEqual([
      "AGENTS.md",
    ]);
    expect(scopeViolations(["AGENTS.md"], { writable: ["AGENTS.md"] })).toEqual([]);
  });

  it("are listed on export, with a package.json whose scripts changed", async () => {
    const source = await realpath(await tempDir("auto-l28-src-"));
    git(source, "init", "-q", "-b", "main");
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
    );
    await mkdir(join(source, "lib"));
    await writeFile(join(source, "lib", "package.json"), JSON.stringify({ name: "lib" }));
    git(source, "add", "-A");
    git(source, "commit", "-q", "-m", "base");
    const server = await fakePoundlock({ respond: () => ({ text: "unused" }) });
    servers.push(server);
    const docker = await fakeDocker(["toolchain:test"]);
    const { run, runDir } = await startAutoRun(
      {
        dir: source,
        plan: {
          cases: [
            { id: "C1", title: "one", objective: "o", acceptanceCriteria: "a", dependsOn: [] },
          ],
          checks: ["true"],
          scope: { writable: [".vscode"] },
        },
        profile: "gate-model",
        image: "toolchain:test",
      },
      {
        paths: new AutoPaths(await tempDir("auto-l28-data-")),
        connection: async () => ({ url: server.url, token: server.token, roles: {}, profiles: {} }),
        project: async () => undefined,
        spawnRunner: () => undefined,
        docker: docker.docker,
        dockerEnv: docker.env,
        freeBytes: async () => 100 * 1024 ** 3,
        home: await tempDir("auto-l28-home-"),
      },
    );
    const write = async (path: string, text: string) => {
      await mkdir(dirname(join(run.worktree, path)), { recursive: true });
      await writeFile(join(run.worktree, path), text);
    };
    await write(".vscode/tasks.json", '{"tasks":[]}');
    await write(
      "package.json",
      JSON.stringify({ name: "x", scripts: { test: "node --test", postinstall: "curl x | sh" } }),
    );
    await write("lib/package.json", JSON.stringify({ name: "lib", version: "2.0.0" }));
    await write("src/app.js", "export {};\n");
    const gitArgs = ["--git-dir", run.gitDir, "--work-tree", run.worktree];
    git(run.worktree, ...gitArgs, "add", "-A");
    git(run.worktree, ...gitArgs, "commit", "-q", "-m", "auto: C1 one");
    const ledger = new AutoLedger(runDir);
    await ledger.append({
      type: "run_started",
      runId: run.runId,
      cases: run.cases,
      limits: run.limits,
      supervision: "detached",
      baseCommit: run.baseCommit,
    });
    await ledger.append({
      type: "checkpoint",
      caseId: "C1",
      commit: git(run.worktree, ...gitArgs, "rev-parse", "HEAD"),
      substantive: true,
      reviewed: false,
    });
    const out = join(await tempDir("auto-l28-out-"), "run.patch");
    const exported = await exportRun(runDir, out);
    expect(exported.runsHere.sort()).toEqual([".vscode/tasks.json", "package.json (scripts)"]);
    expect(await readFile(out, "utf8")).toContain(
      "# Files that run on your machine once applied (review these first): .vscode/tasks.json, package.json (scripts)",
    );
  });
});
