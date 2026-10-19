/**
 * Plan section 5 acceptance: real disposable-project checks. These create
 * temporary projects and run actual discovery and preparation with uv and
 * Python from trusted tool directories, not mocked command generation.
 */
import { constants } from "node:fs";
import { access, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApprovalBroker } from "@core/approval-broker";
import type { EnvironmentPrepareContext, PreparationState } from "@core/environment";
import {
  approvedHostToolDirectories,
  discoverNodeRuntimes,
  trustedRuntimeReadRoots,
  validateTrustedRuntime,
} from "@core/host-tools";
import { environmentRecord, PythonUvAdapter } from "@core/python-uv";
import { runHostCommand } from "@runtime/host-command";
import { resolveCommand } from "@runtime/run-command";
import { sandboxProfile } from "@runtime/sandbox";
import { projectStatusView } from "@shared/project-status";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";
import {
  countingManager,
  engineFor,
  planTask,
  recordingWorker,
  settle,
  workflowFixture,
} from "./support/workflow-fixture";

const UV = "/opt/homebrew/bin/uv";
const HOMEBREW_PYTHON = "/opt/homebrew/bin/python3";
const canRun = (path: string) =>
  access(path, constants.X_OK).then(
    () => true,
    () => false,
  );
const hasToolchain = (await canRun(UV)) && (await canRun(HOMEBREW_PYTHON));
const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

async function project(files: Record<string, string> = {}, name = "My Project") {
  const base = await realpath(await tempDir("dispatch env with spaces "));
  const root = join(base, name);
  await mkdir(root);
  for (const [path, content] of Object.entries(files)) await writeFile(join(root, path), content);
  const home = join(base, "private home");
  await mkdir(home);
  return { base, root, home };
}

/** Execute preparation commands for real, the way Dispatch does, and log them. */
function realContext(
  root: string,
  home: string,
  options: {
    allowDownloads?: boolean;
    deny?: (args: string[]) => boolean;
    state?: { value?: PreparationState };
  } = {},
) {
  const commands: string[][] = [];
  const holder = options.state ?? {};
  const context: EnvironmentPrepareContext = {
    signal: new AbortController().signal,
    allowDownloads: options.allowDownloads ?? true,
    state: {
      read: async () => holder.value,
      write: async (value) => {
        holder.value = structuredClone(value);
      },
    },
    run: async (input) => {
      commands.push([input.program, ...input.arguments]);
      if (options.deny?.(input.arguments))
        return { error: "Tool approval denied or cancelled. Worker stopped." };
      try {
        const result = await runHostCommand(
          {
            program: input.program,
            arguments: input.arguments,
            capability: input.capability,
            effect: input.effect,
            networkMode: input.networkMode,
          },
          {
            projectRoot: root,
            cwd: root,
            extraPath: [],
            privateHome: home,
            trust: "full",
            allowDependencyNetwork: options.allowDownloads ?? true,
            sandboxRequest: {
              projectRoot: root,
              writable: [root, home],
              deniedRead: [],
              network: input.networkMode,
              tmp: home,
            },
            signal: new AbortController().signal,
          },
        );
        return result.error || result.exitCode !== 0
          ? { error: `${result.error ?? `exit ${result.exitCode}`}: ${result.output.trim()}` }
          : { output: result.output };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
  return { context, commands, state: holder };
}

async function hostBin(base: string, links: Record<string, string>) {
  const bin = join(base, "trusted bin");
  await mkdir(bin, { recursive: true });
  for (const [name, target] of Object.entries(links)) await symlink(target, join(bin, name));
  return bin;
}

const NO_DEPS_PROJECT = (requires = ">=3.10") =>
  `[project]\nname = "demo"\nversion = "0.1.0"\nrequires-python = "${requires}"\ndependencies = []\n\n[tool.uv]\npackage = false\n`;

/** Creating a real venv bootstraps pip: seconds alone, far longer while the whole suite runs in parallel. */
const VENV_TIMEOUT = { timeout: 60_000 };

describe.skipIf(!hasToolchain)("real Python environment preparation", VENV_TIMEOUT, () => {
  it("discovers uv and Python from trusted directories under a restricted PATH", async () => {
    const { root } = await project({ "pyproject.toml": NO_DEPS_PROJECT() });
    const original = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const selected = await new PythonUvAdapter().detect(root);
      expect(selected).toMatchObject({ kind: "python-uv", uv: UV, requirement: ">=3.10" });
    } finally {
      process.env.PATH = original;
    }
    expect(approvedHostToolDirectories()).toContain("/opt/homebrew/bin");
  });

  it("creates and verifies .venv with uv in a path containing spaces without creating a lockfile", async () => {
    const { root, home } = await project({ "pyproject.toml": NO_DEPS_PROJECT() });
    const adapter = new PythonUvAdapter();
    const selected = await adapter.detect(root);
    const { context, commands } = realContext(root, home);
    const prepared = await adapter.prepare(root, selected!, context);
    expect(prepared.blocked).toBeUndefined();
    expect(prepared).toMatchObject({
      kind: "configured",
      python: join(root, ".venv", "bin/python"),
      created: true,
    });
    expect(await readFile(join(root, ".venv", "pyvenv.cfg"), "utf8")).toMatch(/version/);
    expect(commands[0]).toEqual([UV, "venv", "--no-python-downloads", join(root, ".venv")]);
    expect(commands.at(-1)).toEqual([
      UV,
      "pip",
      "check",
      "--python",
      join(root, ".venv/bin/python"),
    ]);
    expect(await exists(join(root, "uv.lock"))).toBe(false);
    const record = environmentRecord(prepared);
    expect(record).toMatchObject({ status: "ready", tool: "uv", requirement: ">=3.10" });
    expect(record.detail).toMatch(
      /^Python 3\.\d+\.\d+ in \.venv, created with uv; requires >=3\.10\.$/,
    );
  });

  it("honors uv.lock exactly, never falls back after a real uv failure, and does not repeat recorded steps", async () => {
    const { root, home } = await project({ "pyproject.toml": NO_DEPS_PROJECT() });
    const locked = await runHostCommand(
      {
        program: UV,
        arguments: ["lock", "--offline"],
        capability: "inspect",
        effect: "project_change",
      },
      {
        projectRoot: root,
        cwd: root,
        extraPath: [],
        privateHome: home,
        trust: "full",
        allowDependencyNetwork: false,
        sandboxRequest: {
          projectRoot: root,
          writable: [root],
          deniedRead: [],
          network: "deny",
          tmp: home,
        },
        signal: new AbortController().signal,
      },
    );
    expect(locked.exitCode, locked.output).toBe(0);
    const lock = await readFile(join(root, "uv.lock"), "utf8");
    const adapter = new PythonUvAdapter();
    const state: { value?: PreparationState } = {};
    const first = realContext(root, home, { state });
    const ready = await adapter.prepare(root, (await adapter.detect(root))!, first.context);
    expect(ready.blocked).toBeUndefined();
    expect(first.commands.map((command) => command.slice(1, 3))).toContainEqual([
      "sync",
      "--locked",
    ]);

    // The declaration changes but the lock does not: uv must refuse, and
    // Dispatch must not substitute pip or recreate the environment.
    await writeFile(
      join(root, "pyproject.toml"),
      NO_DEPS_PROJECT().replace('name = "demo"', 'name = "demo-renamed"'),
    );
    const retry = realContext(root, home, { state });
    const blocked = await adapter.prepare(
      root,
      (await adapter.detect(root, { state: state.value }))!,
      retry.context,
    );
    expect(blocked.blocked).toMatch(/Installing dependencies failed/);
    expect(blocked.blocked).toMatch(/uv\.lock was not changed/);
    expect(retry.commands).toHaveLength(1);
    expect(retry.commands[0].slice(1, 3)).toEqual(["sync", "--locked"]);
    expect(await readFile(join(root, "uv.lock"), "utf8")).toBe(lock);
    expect(state.value?.lastError?.step).toBe("dependencies");
    expect(state.value?.created?.virtualenv).toBe(join(root, ".venv"));
  });

  it("falls back to the standard-library venv only when uv is absent, preserving the venv invocation path", async () => {
    const { base, root, home } = await project();
    const bin = await hostBin(base, { python3: HOMEBREW_PYTHON });
    const adapter = new PythonUvAdapter([bin]);
    const selected = await adapter.detect(root, { requested: true });
    expect(selected).toMatchObject({ kind: "python-venv", python: join(bin, "python3") });
    const { context, commands } = realContext(root, home);
    const prepared = await adapter.prepare(root, selected!, context);
    expect(prepared.blocked).toBeUndefined();
    expect(commands[0]).toEqual([join(bin, "python3"), "-m", "venv", join(root, ".venv")]);
    expect(environmentRecord(prepared).detail).toMatch(/venv module \(uv is not installed\)/);

    const venvPython = join(root, ".venv", "bin", "python");
    // The canonical executable is Homebrew's interpreter, outside the venv...
    expect(await realpath(venvPython)).not.toContain(join(root, ".venv"));
    // ...yet executing through the venv path keeps the venv as sys.prefix.
    const result = await runHostCommand(
      {
        program: venvPython,
        arguments: ["-c", "import sys; print(sys.prefix)"],
        capability: "inspect",
        effect: "inspect",
      },
      {
        projectRoot: root,
        cwd: root,
        extraPath: [join(root, ".venv", "bin")],
        privateHome: home,
        trust: "full",
        allowDependencyNetwork: false,
        sandboxRequest: {
          projectRoot: root,
          writable: [root],
          deniedRead: [],
          network: "deny",
          tmp: home,
        },
        signal: new AbortController().signal,
      },
    );
    expect(result.output.trim()).toBe(join(root, ".venv"));
  });

  it("does not fall back to pip when uv is absent but the project declares uv.lock", async () => {
    const { base, root } = await project({
      "pyproject.toml": NO_DEPS_PROJECT(),
      "uv.lock": "version = 1\n",
    });
    const bin = await hostBin(base, { python3: HOMEBREW_PYTHON });
    const selected = await new PythonUvAdapter([bin]).detect(root);
    expect(selected?.blocked).toMatch(/has a uv\.lock file, but uv is not installed/);
    expect(selected?.blocked).toMatch(/Install uv/);
    expect(await exists(join(root, ".venv"))).toBe(false);
  });

  it("blocks with the interpreters it found when none satisfies requires-python", async () => {
    const { base, root } = await project({
      "pyproject.toml": '[project]\nname = "demo"\nrequires-python = ">=3.99"\n',
    });
    const bin = await hostBin(base, { python3: HOMEBREW_PYTHON });
    const selected = await new PythonUvAdapter([bin]).detect(root);
    expect(selected?.blocked).toMatch(/No installed Python satisfies >=3\.99/);
    expect(selected?.blocked).toContain(join(bin, "python3"));
    expect(selected?.blocked).toMatch(/never downloads a Python runtime/);
  });

  it("reports missing tools when neither uv nor Python is in the trusted directories", async () => {
    const { base, root } = await project({ "requirements.txt": "" });
    const empty = await hostBin(base, {});
    const selected = await new PythonUvAdapter([empty]).detect(root);
    expect(selected?.blocked).toMatch(/No Python interpreter was found/);
    expect(selected?.blocked).toMatch(/brew install python/);
  });

  it("reuses an existing compatible venv without running anything, and blocks an incompatible one", async () => {
    const { root, home } = await project({ "pyproject.toml": NO_DEPS_PROJECT() });
    const created = realContext(root, home);
    expect(
      (
        await created.context.run({
          program: HOMEBREW_PYTHON,
          arguments: ["-m", "venv", join(root, ".venv")],
          capability: "inspect",
          effect: "project_change",
          networkMode: "deny",
        })
      ).error,
    ).toBeUndefined();
    const adapter = new PythonUvAdapter();
    const selected = await adapter.detect(root);
    expect(selected).toMatchObject({ kind: "configured", existing: true });
    const { context, commands } = realContext(root, home);
    await adapter.prepare(root, selected!, context);
    expect(commands).toEqual([]);
    expect(environmentRecord(selected!)).toMatchObject({ status: "ready", tool: "existing" });

    await writeFile(join(root, "pyproject.toml"), NO_DEPS_PROJECT("<3.10"));
    const incompatible = await adapter.detect(root);
    expect(incompatible?.blocked).toMatch(/existing \.venv uses Python 3\.\d+.*requires <3\.10/);
    expect(incompatible?.blocked).toMatch(/does not replace an existing environment/);
  });

  it("blocks a partial venv it did not create, and completes one it did", async () => {
    const { root, home } = await project({ "pyproject.toml": NO_DEPS_PROJECT() });
    await mkdir(join(root, ".venv"));
    await writeFile(join(root, ".venv", "pyvenv.cfg"), "home = /nowhere\n");
    const adapter = new PythonUvAdapter();
    const foreign = await adapter.detect(root);
    expect(foreign?.blocked).toMatch(/\.venv exists but is incomplete/);
    expect(foreign?.blocked).toMatch(/Dispatch did not create it/);

    const state = {
      value: { created: { virtualenv: join(root, ".venv"), tool: "uv" as const, at: "t" } },
    };
    const owned = await adapter.detect(root, { state: state.value });
    expect(owned).toMatchObject({ kind: "python-uv", recreate: true });
    const { context, commands } = realContext(root, home, { state });
    const prepared = await adapter.prepare(root, owned!, context);
    expect(prepared.blocked).toBeUndefined();
    expect(commands[0]).toContain("--clear");
    expect(await canRun(join(root, ".venv", "bin", "python"))).toBe(true);
  });

  it("records a denied step and does not try another tool", async () => {
    const { root, home } = await project({ "pyproject.toml": NO_DEPS_PROJECT() });
    const adapter = new PythonUvAdapter();
    const { context, commands, state } = realContext(root, home, { deny: () => true });
    const prepared = await adapter.prepare(root, (await adapter.detect(root))!, context);
    expect(prepared.blocked).toMatch(/Tool approval denied/);
    expect(prepared.blocked).toMatch(/did not fall back/);
    expect(commands).toHaveLength(1);
    expect(state.value?.lastError).toMatchObject({ step: "create" });
    expect(await exists(join(root, ".venv"))).toBe(false);
  });

  it("does not download a declared Python version that is not installed", async () => {
    const { root, home } = await project({
      "pyproject.toml": NO_DEPS_PROJECT(">=3.6"),
      ".python-version": "3.8\n",
    });
    const adapter = new PythonUvAdapter();
    const selected = await adapter.detect(root);
    expect(selected).toMatchObject({ pin: "3.8", requirement: "==3.8.*" });
    const { context, commands } = realContext(root, home);
    const prepared = await adapter.prepare(root, selected!, context);
    expect(commands[0]).toEqual([
      UV,
      "venv",
      "--python",
      "3.8",
      "--no-python-downloads",
      join(root, ".venv"),
    ]);
    expect(prepared.blocked).toMatch(/Install Python 3\.8 \(uv will not download it\)/);
    expect(await exists(join(home, "cache", "uv", "python"))).toBe(false);
  });

  it("prepares the environment through the orchestrator in the sandbox and shows what it selected", async () => {
    const f = await workflowFixture({
      prefix: "dispatch orchestrated env ",
      files: { "pyproject.toml": NO_DEPS_PROJECT() },
      policy: { toolTrust: "assist" },
    });
    const { manager } = countingManager(f.store, {
      tasks: [planTask("Write")],
      environmentNeed: "python",
      downloads: true,
    });
    const { worker, runs } = recordingWorker();
    const engine = engineFor(f, manager, worker, new ApprovalBroker());
    await engine.sendMessage(f.project.id, "Build it");
    await engine.approveAndStart(f.project.id);
    await settle(engine, f.project.id, 2);
    const project = (await f.store.getProject(f.project.id))!;
    expect(project.environment?.detail, JSON.stringify(project.needsInput)).toMatch(
      /created with uv/,
    );
    expect(project.environment?.status).toBe("ready");
    expect(runs).toEqual(["Write"]);
    expect(await canRun(join(f.folder, ".venv", "bin", "python"))).toBe(true);
    expect(
      JSON.parse(
        await readFile(
          join(f.store.layout.root, "projects", f.project.id, "environment-state.json"),
          "utf8",
        ),
      ).created.virtualenv,
    ).toBe(join(f.folder, ".venv"));
  });

  it("turns a blocked environment into a specific recovery instruction", async () => {
    const f = await workflowFixture({
      files: { "pyproject.toml": NO_DEPS_PROJECT(">=3.6"), ".python-version": "3.8\n" },
      policy: { toolTrust: "assist" },
    });
    const { manager } = countingManager(f.store, {
      tasks: [planTask("Write")],
      environmentNeed: "python",
      downloads: true,
    });
    const engine = engineFor(f, manager, recordingWorker().worker, new ApprovalBroker());
    await engine.sendMessage(f.project.id, "Build it");
    await engine.approveAndStart(f.project.id);
    const project = (await f.store.getProject(f.project.id))!;
    expect(project.environment?.status).toBe("blocked");
    const view = projectStatusView({
      project,
      plan: await f.store.getPlan(f.project.id),
      tasks: await f.store.getTasks(f.project.id),
      messages: [],
    });
    expect(view.cause).toBe("environment");
    expect(view.next).toMatch(/Install Python 3\.8 \(uv will not download it\)/);
    expect(view.actions.map((action) => action.id)).toContain("resume");
  });
});

describe("trusted Node runtime selection", () => {
  async function fakeNvm() {
    const home = await realpath(await tempDir("dispatch nvm home "));
    const directory = join(home, ".nvm", "versions", "node", "v25.0.0", "bin");
    await mkdir(directory, { recursive: true });
    await symlink(process.execPath, join(directory, "node"));
    await mkdir(join(home, ".nvm", "versions", "node", "v22.1.0", "bin"), { recursive: true });
    await symlink(
      process.execPath,
      join(home, ".nvm", "versions", "node", "v22.1.0", "bin", "node"),
    );
    return { home, directory };
  }

  it("discovers NVM installs without reading shell configuration", async () => {
    const { home, directory } = await fakeNvm();
    const found = await discoverNodeRuntimes(home);
    expect(found.map((item) => item.version)).toEqual(["v25.0.0", "v22.1.0"]);
    expect(found[0]).toMatchObject({ kind: "node", directory, source: "nvm" });
  });

  it("validates the selection and refuses runtimes inside the project or Dispatch data", async () => {
    const { home, directory } = await fakeNvm();
    expect(await validateTrustedRuntime("node", directory)).toBe(directory);
    await expect(validateTrustedRuntime("node", "relative/bin")).rejects.toThrow(/absolute/);
    await expect(validateTrustedRuntime("node", join(home, ".nvm"))).rejects.toThrow(
      /does not contain/,
    );
    await expect(
      validateTrustedRuntime("node", directory, { projectRoot: join(home, ".nvm") }),
    ).rejects.toThrow(/cannot live inside the project/);
  });

  it("runs an NVM-only node through the explicit selection, ahead of host tools, under a restricted PATH", async () => {
    const { home, directory } = await fakeNvm();
    const root = join(home, "project with spaces");
    await mkdir(root);
    const original = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      const resolved = await resolveCommand(
        { program: "node", arguments: ["--version"], capability: "inspect", effect: "inspect" },
        root,
        [],
        home,
        undefined,
        [directory],
      );
      expect(resolved.invocationPath).toBe(join(directory, "node"));
      expect(resolved.executableSource).toBe("approved_host_tool");
      expect(resolved.env.PATH?.split(":")).not.toContain("/nonexistent");
      const result = await runHostCommand(
        { program: "node", arguments: ["--version"], capability: "inspect", effect: "inspect" },
        {
          projectRoot: root,
          cwd: root,
          extraPath: [],
          runtimeDirs: [directory],
          privateHome: home,
          trust: "full",
          allowDependencyNetwork: false,
          sandboxRequest: {
            projectRoot: root,
            writable: [root],
            deniedRead: [],
            network: "deny",
            tmp: home,
          },
          signal: new AbortController().signal,
        },
      );
      expect(result.output.trim()).toBe(process.version);
    } finally {
      process.env.PATH = original;
    }
    const readable = trustedRuntimeReadRoots({ runtimes: { node: directory } });
    expect(readable).toEqual([join(home, ".nvm", "versions", "node", "v25.0.0")]);
    expect(
      sandboxProfile({
        projectRoot: root,
        writable: [root],
        deniedRead: [],
        readable,
        network: "deny",
        tmp: home,
      }),
    ).toContain(`(subpath "${readable[0]}")`);
  });
});

describe("download authority is needed only for something to fetch", () => {
  it("does not require downloads for a project that declares nothing", async () => {
    const { declaresInstallableDependencies } = await import("@core/python-uv");
    const empty = '[project]\nname = "hello"\nversion = "0.1.0"\nrequires-python = ">=3.14"\n';
    expect(declaresInstallableDependencies(empty, "", "")).toBe(false);
    expect(declaresInstallableDependencies(`${empty}dependencies = []\n`, "", "")).toBe(false);
    expect(
      declaresInstallableDependencies(`${empty}dependencies = [\n  "django>=5",\n]\n`, "", ""),
    ).toBe(true);
    expect(declaresInstallableDependencies("", "# none\n\n", "")).toBe(false);
    expect(declaresInstallableDependencies("", "requests==2\n", "")).toBe(true);
    expect(
      declaresInstallableDependencies(`${empty}[build-system]\nrequires = ["hatchling"]\n`, "", ""),
    ).toBe(true);
    const selfOnlyLock = 'version = 1\n[[package]]\nname = "hello"\nversion = "0.1.0"\n';
    expect(declaresInstallableDependencies(empty, "", selfOnlyLock)).toBe(false);
    expect(
      declaresInstallableDependencies(
        empty,
        "",
        `${selfOnlyLock}[[package]]\nname = "django"\nversion = "6"\n`,
      ),
    ).toBe(true);
  });
});
