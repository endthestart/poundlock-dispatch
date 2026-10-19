import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertHttpsGitUrl,
  forgeHostMatches,
  gitOutput,
  gitRemoteUrl,
  isCommitId,
} from "@core/git";
import { createFolderProject, createGitProject } from "@core/projects";
import { FileStore } from "@core/store";
import { cloneGitRef } from "@core/workspace";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await gitOutput(dir, ["init", "--template="]);
  await gitOutput(dir, ["config", "user.email", "dispatch-test@local"]);
  await gitOutput(dir, ["config", "user.name", "Poundlock Dispatch Test"]);
  await writeFile(join(dir, "README.md"), "hello\n");
  await gitOutput(dir, ["add", "."]);
  await gitOutput(dir, ["commit", "-m", "init"]);
  await gitOutput(dir, ["branch", "-M", "main"]);
  await gitOutput(dir, ["checkout", "-b", "topic"]);
  await writeFile(join(dir, "topic.txt"), "topic\n");
  await gitOutput(dir, ["add", "."]);
  await gitOutput(dir, ["commit", "-m", "topic"]);
  await gitOutput(dir, ["checkout", "main"]);
  return gitOutput(dir, ["rev-parse", "HEAD"]);
}

describe("git URL and refs", () => {
  it("accepts HTTPS remotes and 40-character commits", () => {
    expect(assertHttpsGitUrl("https://github.com/org/repo.git")).toBe(
      "https://github.com/org/repo.git",
    );
    expect(() => assertHttpsGitUrl("git@github.com:org/repo.git")).toThrow(/HTTPS/);
    expect(isCommitId("0123456789abcdef0123456789abcdef01234567")).toBe(true);
    expect(isCommitId("main")).toBe(false);
    expect(forgeHostMatches("https://github.com/org/repo.git", "https://github.com")).toBe(true);
    expect(forgeHostMatches("https://gitea.example.net/org/repo.git", "https://github.com")).toBe(
      false,
    );
  });
});

describe("integrations store", () => {
  it("keeps forge tokens out of the public integrations file", async () => {
    const root = await tempDir("dispatch-int-");
    const store = new FileStore(root);
    await store.init();
    await store.saveGithub({
      host: "https://github.com",
      username: "example-user",
      token: "ghp_test_token_not_for_github",
    });
    const publicFile = JSON.parse(await readFile(store.layout.config.integrations, "utf8")) as {
      github?: { token?: string; username?: string };
    };
    const secretFile = JSON.parse(
      await readFile(store.layout.config.integrationsSecret, "utf8"),
    ) as {
      github?: { token?: string };
    };
    expect(publicFile.github?.username).toBe("example-user");
    expect(publicFile.github?.token).toBeUndefined();
    expect(secretFile.github?.token).toBe("ghp_test_token_not_for_github");
    const published = await store.getIntegrationsPublic();
    expect(published.github).toEqual({
      configured: true,
      host: "https://github.com",
      username: "example-user",
    });
    const creds = await store.getForgeCredentials("github");
    expect(creds?.token).toBe("ghp_test_token_not_for_github");
    await store.removeForge("github");
    expect((await store.getIntegrationsPublic()).github).toBeUndefined();
  });

  it("keeps an existing token when the replacement field is blank", async () => {
    const root = await tempDir("dispatch-int-keep-");
    const store = new FileStore(root);
    await store.init();
    await store.saveGitea({
      host: "https://gitea.example.net",
      username: "ops",
      token: "gitea-token-1",
    });
    await store.saveGitea({
      host: "https://gitea.example.net",
      username: "ops",
      token: "",
    });
    expect((await store.getForgeCredentials("gitea"))?.token).toBe("gitea-token-1");
  });
});

describe("git clone by branch or commit", () => {
  it("checks out a named branch", async () => {
    const root = await tempDir("dispatch-git-");
    const origin = join(root, "origin");
    await initRepo(origin);
    const workspace = join(root, "checkout");
    await cloneGitRef(workspace, origin, "topic");
    expect(await readFile(join(workspace, "topic.txt"), "utf8")).toBe("topic\n");
  });

  it("creates a git project from a branch ref without lowercasing the name", async () => {
    const root = await tempDir("dispatch-git-proj-");
    const origin = join(root, "origin");
    await initRepo(origin);
    const store = new FileStore(join(root, "data"));
    await store.init();
    const project = await createGitProject({
      store,
      repository: origin,
      revision: "topic",
      name: "demo",
      forge: "github",
    });
    expect(project.source.kind).toBe("git");
    if (project.source.kind !== "git") throw new Error("expected git source");
    expect(project.source.revision).toBe("topic");
    expect(project.source.forge).toBe("github");
    expect(project.source.baseRevision).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("folder git remote", () => {
  it("records origin only when the chosen folder is the git root", async () => {
    const root = await tempDir("dispatch-folder-git-");
    const origin = join(root, "origin");
    await initRepo(origin);
    await gitOutput(origin, ["remote", "add", "origin", "https://github.com/example/demo.git"]);
    const store = new FileStore(join(root, "data"));
    await store.init();
    const nestedDir = join(origin, "src");
    await mkdir(nestedDir);
    const nested = await createFolderProject({ store, folder: nestedDir, name: "nested" });
    if (nested.source.kind !== "local_folder") throw new Error("expected folder source");
    expect(nested.source.gitRemote).toBeUndefined();
    const project = await createFolderProject({ store, folder: origin, name: "demo" });
    if (project.source.kind !== "local_folder") throw new Error("expected folder source");
    expect(project.source.gitRemote).toBe("https://github.com/example/demo.git");
    expect(await gitRemoteUrl(root)).toBeUndefined();
  });
});
