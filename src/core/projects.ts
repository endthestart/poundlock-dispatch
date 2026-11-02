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
  const gitRemote = await gitRemoteUrl(root);
  return newProjectRecord({
    store: options.store,
    id,
    name: options.name || basename(root),
    now,
    source: {
      kind: "local_folder",
      originalPath: root,
      baseRevision: "",
      excludedPatterns: options.extraExclusions ?? [...DEFAULT_EXCLUSIONS],
      gitRemote,
      forge: options.forge,
    },
    policy: options.policy,
  });
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
  return newProjectRecord({
    store: options.store,
    id,
    name: options.name || options.repository,
    now,
    source: {
      kind: "git",
      repository: options.repository.trim(),
      revision: isCommitId(ref) ? ref.toLowerCase() : ref,
      baseRevision: head,
      hasCredentials: Boolean(options.credentials),
      forge: options.forge,
    },
    policy: options.policy,
  });
}

/** Save a new draft project, with an empty board and conversation. */
async function newProjectRecord(options: {
  store: FileStore;
  id: string;
  name: string;
  now: string;
  source: ProjectRecord["source"];
  policy?: Partial<ProjectPolicy>;
}): Promise<ProjectRecord> {
  const identity = newWorkflowIdentity();
  const project: ProjectRecord = {
    id: options.id,
    name: options.name,
    archived: false,
    createdAt: options.now,
    updatedAt: options.now,
    status: "draft",
    source: options.source,
    policy: { ...defaultPolicy(), ...options.policy },
    budget: defaultBudget(),
    integration: {},
    planRevision: 0,
    workflowId: identity.workflowId,
    managerSessionId: identity.managerConversationId,
  };
  await options.store.saveProject(project);
  await options.store.saveTasks(options.id, []);
  await options.store.saveMessages(options.id, []);
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
