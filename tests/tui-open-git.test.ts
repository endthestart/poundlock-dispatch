/**
 * `dispatch --git <url> --branch <ref>`: the command line names a Git
 * repository project, the same repository and branch reopen it, and a new one
 * is added through the host as the app adds it.
 */
import { join } from "node:path";
import type { DispatchHost } from "@core/host/dispatch-host";
import { FileStore } from "@core/store";
import type { AppStateView, ProjectRecord } from "@shared/types";
import { openGitProject, parseGitOpen, withoutGitFlags } from "@tui/open-git";
import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

const URL_ = "https://github.com/example/gpu-survey.git";

describe("parseGitOpen", () => {
  it("reads the repository, the branch and the account, and leaves the rest", () => {
    const args = ["--git", URL_, "--branch", "main", "--account", "github", "--json"];
    expect(parseGitOpen(args)).toEqual({ repository: URL_, revision: "main", forge: "github" });
    expect(withoutGitFlags(args)).toEqual(["--json"]);
    expect(parseGitOpen(["./folder"])).toBeUndefined();
  });

  it("refuses a repository without a branch, an unknown account, or a branch alone", () => {
    expect(() => parseGitOpen(["--git", URL_])).toThrow("Name the branch or commit with --branch");
    expect(() => parseGitOpen(["--git", URL_, "--branch", "main", "--account", "gitlab"])).toThrow(
      "--account is github or gitea",
    );
    expect(() => parseGitOpen(["--branch", "main"])).toThrow(/^Usage: dispatch --git/);
  });
});

describe("openGitProject", () => {
  it("reopens the project for the same repository and branch, and adds one otherwise", async () => {
    const store = new FileStore(join(await tempDir("tui-open-git-"), "data"));
    await store.init();
    const existing = {
      id: "proj_existing",
      archived: false,
      source: { kind: "git", repository: URL_, revision: "main" },
    } as ProjectRecord;
    vi.spyOn(store, "listProjects").mockResolvedValue([existing]);
    const added = { id: "proj_new" } as ProjectRecord;
    const host = {
      createProjectFromGit: vi.fn(
        async () => ({ projects: [added], selectedProjectId: "proj_new" }) as AppStateView,
      ),
    } as unknown as DispatchHost;
    expect(await openGitProject(host, store, { repository: URL_, revision: "main" })).toBe(
      existing,
    );
    expect(host.createProjectFromGit).not.toHaveBeenCalled();
    // Branch names are case-sensitive: Main is another branch.
    const other = { repository: URL_, revision: "Main", forge: "github" as const };
    expect(await openGitProject(host, store, other)).toBe(added);
    expect(host.createProjectFromGit).toHaveBeenCalledWith(other);
  });
});
