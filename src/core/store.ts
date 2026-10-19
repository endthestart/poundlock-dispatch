import { constants } from "node:fs";
import { access, chmod, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { type AppearanceSettings, normalizeAppearance } from "@shared/appearance";
import { normalizePermissions, type PermissionSettings } from "@shared/permissions";
import { type RoleMap, roleMapReady } from "@shared/roles";
import {
  type ChatMessage,
  type ConnectionPublic,
  type ConnectionSettings,
  EXAMPLE_CONTROLLER_URL,
  type ForgeKind,
  type IntegrationsPublic,
  type PendingBoardChange,
  type PlanRecord,
  type ProjectRecord,
  type TaskRecord,
} from "@shared/types";
import {
  readSavedUiPreferences,
  savedUiPreferences,
  type UiPreferences,
} from "@shared/ui-preferences";
import { writeFileAtomic, writeJsonAtomic } from "./atomic-write.js";
import { withoutJobBindings } from "./durable-retirement.js";
import { type DataLayout, layoutFor, projectFiles } from "./paths.js";

/** A project id as `newId("proj")` makes it; anything else never reaches the filesystem. */
const PROJECT_ID = /^proj_[0-9a-f-]{36}$/;

export class FileStore {
  readonly layout: DataLayout;
  private mutations = new Map<string, Promise<unknown>>();
  private serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(work);
    this.mutations.set(key, result);
    void result
      .finally(() => {
        if (this.mutations.get(key) === result) this.mutations.delete(key);
      })
      .catch(() => undefined);
    return result;
  }
  async appendMessage(projectId: string, message: ChatMessage): Promise<void> {
    await this.serial(`messages:${projectId}`, async () => {
      const messages = await this.getMessages(projectId);
      await this.saveMessages(projectId, [...messages, message]);
    });
  }
  async updateMessage(
    projectId: string,
    messageId: string,
    patch: Partial<ChatMessage>,
  ): Promise<void> {
    await this.serial(`messages:${projectId}`, async () => {
      const messages = await this.getMessages(projectId);
      const index = messages.findIndex((m) => m.id === messageId);
      if (index === -1) return;
      const next = [...messages];
      next[index] = { ...next[index], ...patch };
      await this.saveMessages(projectId, next);
    });
  }

  constructor(root: string, configRoot?: string) {
    this.layout = layoutFor(root, configRoot);
  }

  async init(): Promise<void> {
    await mkdir(this.layout.projectsDir, { recursive: true, mode: 0o700 });
    await mkdir(this.layout.root, { recursive: true, mode: 0o700 });
    await mkdir(this.layout.config.root, { recursive: true, mode: 0o700 });
    // mkdir's mode applies only to a folder it creates. A folder that already
    // existed keeps whatever it had, and these hold tokens (L27).
    await chmod(this.layout.root, 0o700);
    await chmod(this.layout.config.root, 0o700);
  }

  async getConnection(): Promise<ConnectionSettings> {
    const publicPart = await readJsonIfExists<{
      url?: string;
      roles?: RoleMap;
      profiles?: ConnectionSettings["profiles"];
      escalation?: ConnectionSettings["escalation"];
      localManager?: Omit<NonNullable<ConnectionSettings["localManager"]>, "token">;
      webSearch?: ConnectionSettings["webSearch"];
    }>(this.layout.config.connection);
    const secret = await readJsonIfExists<{ token?: string; localManagerToken?: string }>(
      this.layout.config.secret,
    );
    const { roles, escalation } = withoutJobBindings({
      roles: publicPart?.roles ?? {},
      escalation: publicPart?.escalation,
    });
    return {
      url: publicPart?.url?.trim() || "",
      token: secret?.token ?? "",
      roles,
      profiles: publicPart?.profiles ?? {},
      escalation,
      localManager: publicPart?.localManager
        ? { ...publicPart.localManager, token: secret?.localManagerToken ?? "" }
        : undefined,
      ...(publicPart?.webSearch?.url?.trim()
        ? { webSearch: { url: publicPart.webSearch.url.trim() } }
        : {}),
    };
  }

  async getConnectionPublic(): Promise<ConnectionPublic> {
    const conn = await this.getConnection();
    return {
      url: conn.url,
      tokenConfigured: conn.token.length > 0,
      roles: conn.roles,
      profiles: conn.profiles,
      escalation: conn.escalation,
      localManager: conn.localManager
        ? {
            enabled: conn.localManager.enabled,
            url: conn.localManager.url,
            model: conn.localManager.model,
            contextTokens: conn.localManager.contextTokens,
            maxOutputTokens: conn.localManager.maxOutputTokens,
            tokenConfigured: Boolean(conn.localManager.token),
          }
        : undefined,
      rolesReady: roleMapReady(conn.roles),
      ...(conn.webSearch ? { webSearch: conn.webSearch } : {}),
    };
  }

  async saveConnection(settings: ConnectionSettings): Promise<void> {
    const existing = await this.getConnection();
    const changed = settings.url.trim().replace(/\/+$/, "") !== existing.url.replace(/\/+$/, "");
    await writeJsonAtomic(this.layout.config.connection, {
      url: settings.url.trim(),
      roles: settings.roles ?? (changed ? {} : existing.roles),
      profiles: settings.profiles ?? (changed ? {} : existing.profiles),
      escalation: changed ? undefined : (settings.escalation ?? existing.escalation),
      localManager: settings.localManager
        ? {
            enabled: settings.localManager.enabled,
            url: settings.localManager.url,
            model: settings.localManager.model,
            contextTokens: settings.localManager.contextTokens,
            maxOutputTokens: settings.localManager.maxOutputTokens,
          }
        : existing.localManager
          ? {
              enabled: existing.localManager.enabled,
              url: existing.localManager.url,
              model: existing.localManager.model,
              contextTokens: existing.localManager.contextTokens,
              maxOutputTokens: existing.localManager.maxOutputTokens,
            }
          : undefined,
      // Kept across connection changes: it is the owner's own search engine.
      webSearch: settings.webSearch ?? existing.webSearch,
      example: EXAMPLE_CONTROLLER_URL,
      note: "example is documentation only and is not used unless you save it as url",
    });
    await writeJsonAtomic(
      this.layout.config.secret,
      {
        token: settings.token.trim() ? settings.token : changed ? "" : existing.token,
        localManagerToken: settings.localManager?.token.trim()
          ? settings.localManager.token
          : (existing.localManager?.token ?? ""),
      },
      0o600,
    );
  }

  /** Set or clear the SearXNG instance web search uses. */
  async saveWebSearch(settings: ConnectionSettings["webSearch"] | null): Promise<void> {
    const existing = await readJsonIfExists<Record<string, unknown>>(this.layout.config.connection);
    const url = settings?.url.trim().replace(/\/+$/, "");
    if (url && !/^https?:\/\/[^\s]+$/.test(url))
      throw new Error("The search engine address must start with http:// or https://.");
    const next = { ...(existing ?? { url: "", roles: {} }) };
    if (url) next.webSearch = { url };
    else delete next.webSearch;
    await writeJsonAtomic(this.layout.config.connection, next);
  }

  async clearConnection(): Promise<void> {
    await writeJsonAtomic(this.layout.config.connection, { url: "", roles: {} });
    await writeJsonAtomic(this.layout.config.secret, { token: "", localManagerToken: "" });
  }

  async getIntegrationsPublic(): Promise<IntegrationsPublic> {
    const publicPart = await readIntegrationsPublic(this.layout.config.integrations);
    const secret = await readIntegrationsSecret(this.layout.config.integrationsSecret);
    return {
      github: publicPart.github
        ? {
            configured: Boolean(secret.github?.token),
            host: publicPart.github.host || DEFAULT_GITHUB_HOST,
            username: publicPart.github.username,
          }
        : undefined,
      gitea: publicPart.gitea
        ? {
            configured: Boolean(secret.gitea?.token),
            host: publicPart.gitea.host,
            username: publicPart.gitea.username,
          }
        : undefined,
    };
  }

  async getForgeCredentials(
    kind: ForgeKind,
  ): Promise<{ host: string; username: string; token: string } | undefined> {
    const publicPart = await readIntegrationsPublic(this.layout.config.integrations);
    const secret = await readIntegrationsSecret(this.layout.config.integrationsSecret);
    const account = publicPart[kind];
    const token = secret[kind]?.token?.trim() ?? "";
    if (!account || !token) return undefined;
    return {
      host: account.host,
      username: account.username,
      token,
    };
  }

  async saveGithub(account: { host: string; username: string; token: string }): Promise<void> {
    await saveForgeAccount(this, "github", {
      host: account.host.trim() || DEFAULT_GITHUB_HOST,
      username: account.username.trim(),
      token: account.token,
    });
  }

  async saveGitea(account: { host: string; username: string; token: string }): Promise<void> {
    const host = account.host.trim();
    if (!host) throw new Error("Enter the Gitea base URL, such as https://gitea.example.net.");
    await saveForgeAccount(this, "gitea", {
      host,
      username: account.username.trim(),
      token: account.token,
    });
  }

  /**
   * Permissions come from two places on purpose. The default trust mode and
   * the reviewer profile describe how this machine is set up, so every client
   * shares them; saved grants are keyed by project id, so they follow the
   * projects and stay with the client that owns them.
   */
  async getPermissions(): Promise<PermissionSettings> {
    const defaults = await readJsonIfExists<Omit<PermissionSettings, "grants">>(
      this.layout.config.defaults,
    );
    const local = await readJsonIfExists<Pick<PermissionSettings, "grants">>(
      this.layout.permissions,
    );
    return normalizePermissions({
      ...defaults,
      ...(local?.grants ? { grants: local.grants } : {}),
    });
  }

  async savePermissions(settings: PermissionSettings): Promise<void> {
    const { grants, ...defaults } = normalizePermissions(settings);
    await writeJsonAtomic(this.layout.config.defaults, defaults);
    await writeJsonAtomic(this.layout.permissions, grants ? { grants } : {});
  }

  async getUiPreferences(): Promise<UiPreferences> {
    return readSavedUiPreferences(await readJsonIfExists(this.layout.ui));
  }

  async saveUiPreferences(settings: UiPreferences): Promise<void> {
    await writeJsonAtomic(this.layout.ui, savedUiPreferences(settings));
  }

  /**
   * The theme flavour, shared machine-wide like the connection and default
   * trust mode: every Dispatch client — this desktop app and the TUI — reads
   * the same file so picking a flavour once changes both.
   */
  async getAppearance(): Promise<AppearanceSettings> {
    return normalizeAppearance(await readJsonIfExists(this.layout.config.appearance));
  }

  async saveAppearance(settings: Partial<AppearanceSettings>): Promise<void> {
    await writeJsonAtomic(this.layout.config.appearance, normalizeAppearance(settings));
  }

  async removeForge(kind: ForgeKind): Promise<void> {
    const publicPart = await readIntegrationsPublic(this.layout.config.integrations);
    const secret = await readIntegrationsSecret(this.layout.config.integrationsSecret);
    delete publicPart[kind];
    delete secret[kind];
    await writeJsonAtomic(this.layout.config.integrations, publicPart);
    await writeJsonAtomic(this.layout.config.integrationsSecret, secret, 0o600);
  }

  /**
   * Each project's own `project.json` is the record. `projects.json` held a
   * copy of every project and each save rewrote it whole, so two processes
   * sharing a data root (the app, the terminal, an Autopilot runner) could
   * undo each other's saves of different projects. It is still written, for
   * an older client, and never read.
   */
  async listProjects(): Promise<ProjectRecord[]> {
    const entries = await readdir(this.layout.projectsDir, { withFileTypes: true }).catch(() => []);
    const records = await Promise.all(
      entries.filter((entry) => entry.isDirectory()).map((entry) => this.getProject(entry.name)),
    );
    return records
      .filter((record): record is ProjectRecord => Boolean(record))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    if (!PROJECT_ID.test(id)) return undefined;
    return (
      (await readJsonIfExists<ProjectRecord>(projectFiles(this.layout.root, id).record)) ??
      undefined
    );
  }

  async saveProject(project: ProjectRecord): Promise<void> {
    await this.serial("index", async () => {
      const current = await this.getProject(project.id);
      if ((current?.policy.toolTrustRevision ?? 0) > (project.policy.toolTrustRevision ?? 0)) {
        project.policy.toolTrust = current!.policy.toolTrust;
        project.policy.toolTrustRevision = current!.policy.toolTrustRevision;
      }
      const files = projectFiles(this.layout.root, project.id);
      await mkdir(files.dir, { recursive: true, mode: 0o700 });
      await writeJsonAtomic(files.record, project);
      await this.writeLegacyIndex();
    });
  }

  async deleteProjectRecord(id: string): Promise<ProjectRecord | undefined> {
    return this.serial("index", async () => {
      const existing = await this.getProject(id);
      await rm(projectFiles(this.layout.root, id).record, { force: true });
      await this.writeLegacyIndex();
      return existing;
    });
  }

  /** `projects.json` for a client from before per-project records were read. */
  private async writeLegacyIndex(): Promise<void> {
    await writeJsonAtomic(this.layout.projectsIndex, await this.listProjects());
  }

  async archiveCurrentRun(
    projectId: string,
    options?: { keepConversation?: boolean },
  ): Promise<void> {
    const files = projectFiles(this.layout.root, projectId);
    const archivedAt = new Date().toISOString();
    const id = `run-${crypto.randomUUID()}`;
    const directory = `${files.dir}/run-history`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(`${directory}/${id}.json`, {
      id,
      archivedAt,
      project: await this.getProject(projectId),
      plan: await this.getPlan(projectId),
      tasks: await this.getTasks(projectId),
      messages: await this.getMessages(projectId),
      managerNotes: await readFile(`${files.notes}/manager.md`, "utf8").catch(() => ""),
      managerBrief: await this.getBrief(projectId),
    });
    // The complete record is durable before clearing the current view.
    await rm(files.plan, { force: true });
    await rm(files.pendingBoard, { force: true });
    await this.saveTasks(projectId, []);
    if (!options?.keepConversation) {
      await this.saveMessages(projectId, []);
      await rm(`${files.notes}/manager.md`, { force: true });
      await rm(`${files.notes}/brief.md`, { force: true });
    }
  }

  async getRunHistory(projectId: string): Promise<import("@shared/types").RunHistoryRecord[]> {
    const directory = `${projectFiles(this.layout.root, projectId).dir}/run-history`;
    const names = await readdir(directory).catch(() => [] as string[]);
    const records = await Promise.all(
      names
        .filter((name) => /^run-[a-f0-9-]+\.json$/.test(name))
        .map(async (name) => {
          const record = await readJsonIfExists<import("@shared/types").RunHistoryRecord>(
            `${directory}/${name}`,
          );
          return record
            ? {
                id: record.id,
                archivedAt: record.archivedAt,
                plan: record.plan,
                tasks: record.tasks,
                messages: record.messages,
              }
            : undefined;
        }),
    );
    return records
      .filter((record): record is NonNullable<typeof record> => Boolean(record))
      .sort((a, b) => b.archivedAt.localeCompare(a.archivedAt));
  }

  async savePlan(projectId: string, plan: PlanRecord): Promise<void> {
    await writeJsonAtomic(projectFiles(this.layout.root, projectId).plan, plan);
  }

  async getPlan(projectId: string): Promise<PlanRecord | undefined> {
    return readJsonIfExists<PlanRecord>(projectFiles(this.layout.root, projectId).plan);
  }

  async saveTasks(projectId: string, tasks: TaskRecord[]): Promise<void> {
    await writeJsonAtomic(projectFiles(this.layout.root, projectId).tasks, tasks);
  }

  async getTasks(projectId: string): Promise<TaskRecord[]> {
    return (
      (await readJsonIfExists<TaskRecord[]>(projectFiles(this.layout.root, projectId).tasks)) ?? []
    );
  }

  async savePendingBoard(projectId: string, change: PendingBoardChange): Promise<void> {
    await writeJsonAtomic(projectFiles(this.layout.root, projectId).pendingBoard, change);
  }

  async getPendingBoard(projectId: string): Promise<PendingBoardChange | undefined> {
    return readJsonIfExists<PendingBoardChange>(
      projectFiles(this.layout.root, projectId).pendingBoard,
    );
  }

  async clearPendingBoard(projectId: string): Promise<void> {
    await rm(projectFiles(this.layout.root, projectId).pendingBoard, { force: true });
  }

  /** The project brief the manager keeps pinned in its context; "" when it has none. */
  async getBrief(projectId: string): Promise<string> {
    const { notes } = projectFiles(this.layout.root, projectId);
    return readFile(`${notes}/brief.md`, "utf8").catch(() => "");
  }

  async saveBrief(projectId: string, brief: string): Promise<void> {
    const { notes } = projectFiles(this.layout.root, projectId);
    await writeFileAtomic(`${notes}/brief.md`, brief);
  }

  async saveMessages(projectId: string, messages: ChatMessage[]): Promise<void> {
    await writeJsonAtomic(projectFiles(this.layout.root, projectId).messages, messages);
  }

  async getMessages(projectId: string): Promise<ChatMessage[]> {
    return (
      (await readJsonIfExists<ChatMessage[]>(projectFiles(this.layout.root, projectId).messages)) ??
      []
    );
  }
}

const DEFAULT_GITHUB_HOST = "https://github.com";

interface ForgePublicFile {
  host: string;
  username: string;
}

interface IntegrationsPublicFile {
  github?: ForgePublicFile;
  gitea?: ForgePublicFile;
}

interface IntegrationsSecretFile {
  github?: { token: string };
  gitea?: { token: string };
}

async function readIntegrationsPublic(file: string): Promise<IntegrationsPublicFile> {
  return (await readJsonIfExists<IntegrationsPublicFile>(file)) ?? {};
}

async function readIntegrationsSecret(file: string): Promise<IntegrationsSecretFile> {
  return (await readJsonIfExists<IntegrationsSecretFile>(file)) ?? {};
}

async function saveForgeAccount(
  store: FileStore,
  kind: ForgeKind,
  account: { host: string; username: string; token: string },
): Promise<void> {
  if (!account.username) {
    throw new Error(kind === "github" ? "Enter a GitHub username." : "Enter a Gitea username.");
  }
  const publicPart = await readIntegrationsPublic(store.layout.config.integrations);
  const secret = await readIntegrationsSecret(store.layout.config.integrationsSecret);
  publicPart[kind] = { host: account.host, username: account.username };
  const token = account.token.trim();
  if (token) {
    secret[kind] = { token };
  } else if (!secret[kind]?.token) {
    throw new Error(
      kind === "github"
        ? "Paste a GitHub personal access token with contents and pull requests."
        : "Paste a Gitea access token.",
    );
  }
  await writeJsonAtomic(store.layout.config.integrations, publicPart);
  await writeJsonAtomic(store.layout.config.integrationsSecret, secret, 0o600);
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    await access(file, constants.R_OK);
  } catch {
    return undefined;
  }
  const raw = await readFile(file, "utf8");
  if (!raw.trim()) return undefined;
  return JSON.parse(raw) as T;
}
