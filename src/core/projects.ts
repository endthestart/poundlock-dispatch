import { mkdir, realpath } from "node:fs/promises";
import { basename } from "node:path";
import type { ForgeKind, ProjectPolicy, ProjectRecord } from "@shared/types";
import { DEFAULT_EXCLUSIONS, defaultBudget, defaultPolicy } from "@shared/types";
import { gitRemoteUrl, isCommitId } from "./git.js";
import { newId, nowIso } from "./ids.js";
import { projectFiles } from "./paths.js";
import { FileStore } from "./store.js";
import { newWorkflowIdentity } from "./workflow-identity.js";
import { cloneGitRef } from "./workspace.js";

export async function createFolderProject(options: {
  store: FileStore;
  folder: string;
  name?: string;
  extraExclusions?: string[];
  include?: string[];
  policy?: Partial<ProjectPolicy>;
  forge?: ForgeKind;
}): Promise<ProjectRecord> {
  const root = await realpath(options.folder);
  const id = newId("proj");
  const files = projectFiles(options.store.layout.root, id);
  await mkdir(files.dir, { recursive: true, mode: 0o700 });
  await mkdir(files.notes, { recursive: true, mode: 0o700 });
  const now = nowIso();
  const policy = { ...defaultPolicy(), ...options.policy };
  const gitRemote = await gitRemoteUrl(root);
  const identity = newWorkflowIdentity();
  const project: ProjectRecord = {
    id,
    name: options.name || basename(root),
    archived: false,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      kind: "local_folder",
      originalPath: root,
      capturedAt: now,
      snapshotSha256: "",
      baseRevision: "",
      includedFiles: 0,
      includedBytes: 0,
      excludedPatterns: options.extraExclusions ?? [...DEFAULT_EXCLUSIONS],
      includedUncommitted: true,
      originalFingerprint: "",
      gitRemote,
      forge: options.forge,
    },
    policy,
    budget: defaultBudget(),
    integration: {
      headRevision: "",
      expectedBase: "",
      appliedPatchSha256: [],
    },
    planRevision: 0,
    workflowId: identity.workflowId,
    managerSessionId: identity.managerConversationId,
    eventCursor: 0,
  };
  await options.store.saveProject(project);
  await options.store.saveTasks(id, []);
  await options.store.saveMessages(id, []);
  return project;
}

export async function createGitProject(options: {
  store: FileStore;
  repository: string;
  revision: string;
  credentials?: { username: string; token: string };
  name?: string;
  policy?: Partial<ProjectPolicy>;
  forge?: ForgeKind;
}): Promise<ProjectRecord> {
  const id = newId("proj");
  const files = projectFiles(options.store.layout.root, id);
  await mkdir(files.dir, { recursive: true, mode: 0o700 });
  await mkdir(files.notes, { recursive: true, mode: 0o700 });
  const ref = options.revision.trim();
  const head = await cloneGitRef(files.workspace, options.repository, ref, options.credentials);
  const now = nowIso();
  const policy = { ...defaultPolicy(), ...options.policy };
  const identity = newWorkflowIdentity();
  const project: ProjectRecord = {
    id,
    name: options.name || options.repository,
    archived: false,
    createdAt: now,
    updatedAt: now,
    status: "draft",
    source: {
      kind: "git",
      repository: options.repository.trim(),
      revision: isCommitId(ref) ? ref.toLowerCase() : ref,
      capturedAt: now,
      baseRevision: head,
      hasCredentials: Boolean(options.credentials),
      forge: options.forge,
    },
    policy,
    budget: defaultBudget(),
    integration: {
      headRevision: head,
      expectedBase: head,
      appliedPatchSha256: [],
    },
    planRevision: 0,
    workflowId: identity.workflowId,
    managerSessionId: identity.managerConversationId,
    eventCursor: 0,
  };
  await options.store.saveProject(project);
  await options.store.saveTasks(id, []);
  await options.store.saveMessages(id, []);
  return project;
}

export async function attachProjectForge(
  project: ProjectRecord,
  forge: ForgeKind | undefined,
): Promise<ProjectRecord> {
  const source = { ...project.source };
  if (forge) source.forge = forge;
  else delete source.forge;
  project.source = source;
  project.updatedAt = nowIso();
  return project;
}
