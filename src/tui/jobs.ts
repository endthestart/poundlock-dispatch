/**
 * Durable Poundlock jobs from a shell: `poundlock-dispatch-tui jobs <command>`.
 *
 * This folds the old standalone `pdcli` job commands into Dispatch. It adds no
 * second client: requests go through `PoundlockClient`, uploads are built by
 * `collectLiveSnapshot` (the same exclusion floor the desktop app uses), and the
 * connection is the one every Dispatch client shares in `~/.config/poundlock/dispatch`.
 * Nothing here needs a project, a folder lock or a manager, so it never builds a host.
 *
 * Three things are deliberate:
 *  - The token is read once and handed to the client. It has no flag (argv is
 *    visible to every process), and nothing this file writes can contain it: text
 *    is redacted on the way out and a patch that holds it is refused.
 *  - `--dir` has no default. Uploading a folder to a controller is a decision, so
 *    the command never reaches for the current directory.
 *  - Text from a controller, or from inside a job, is not ours. It is stripped of
 *    anything a terminal would act on before it is printed.
 *
 * Exit codes: 0 done, 1 failed (including a job that ended failed or cancelled),
 * 2 wrong usage.
 */

import { readFile, stat, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { defaultConfigRoot } from "@core/paths";
import {
  PoundlockClient,
  PoundlockError,
  type PoundlockJob,
  parseJobResult,
  requestHash,
  type SubmitJobInput,
} from "@core/poundlock";
import { collectLiveSnapshot } from "@core/snapshot";
import { verificationFailed } from "@core/workflow-support";
import { displaySafe } from "@shared/display-safe";
import { type ConnectionProbe, JOB_PERMISSIONS, permissionLabel } from "@shared/types";

/** Where output goes. `out` and `err` take finished text, newline included. */
export interface JobsIo {
  out(text: string): void;
  err(text: string): void;
  /** Whether stdout is a terminal, which decides if a patch is made safe to print. */
  outIsTty: boolean;
}

export interface JobsDeps {
  /** The saved connection. Read only when a command needs the controller. */
  connection(): Promise<{ url: string; token: string }>;
  io: JobsIo;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export const JOBS_USAGE = `Usage: poundlock-dispatch-tui jobs <command> [options]

Durable Poundlock jobs, using the connection saved in Poundlock Dispatch.

Commands:
  probe                   Check the controller and what this token may do.
  submit                  Upload a folder and start a job; prints the job id.
  watch <id>              Follow a job's events until it finishes.
  patch <id>              Print or save a finished job's patch.
  cancel <id>             Ask the controller to cancel a job.

submit options:
  --dir <path>                 Folder to upload (required; never defaults to here).
  --prompt-file <path>         File holding the task text (required).
  --model-profile-id <id>      Model profile to run on (required).
  --harness-profile-id <id>    Harness profile (default: pi).
  --verify <command>           Check to run afterwards; repeatable.
  --protect <path>             Path the job must not change; repeatable.
  --protect-existing <path>    Path whose existing files must not change; repeatable.
  --network <mode>             inference_only (default) or outbound.
  --max-repairs <n>            In-job repair rounds, 0 to 3 (default: 0). The job's
                               2 MiB agent-output budget is split across the original
                               attempt and its repairs: 2 MiB at 0, 1 MiB at 1, 512 KiB
                               at 3. Large file reads use it up fastest.
  --dependency-freshness       Resolve package versions from the registry.
  --idempotency-key <key>      Default: derived from the input, so an identical
                               resubmit returns the same job. Pass a new key to
                               run the same input again.
  --dry-run                    List what would be uploaded, upload nothing.

patch options:
  --index <n>                  Patch index (default: 0).
  --attempt <n>                Attempt number.
  --save <file>                Write the patch here instead of printing it.

Never uploaded: anything .gitignore excludes, plus .env files (but not
.env.example), private keys, secrets.json and other credential files.
Exit codes: 0 done, 1 failed, 2 wrong usage.
`;

/** A mistake in how the command was written, as opposed to a job or network failure. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

export interface SubmitOptions {
  dir: string;
  promptFile: string;
  modelProfileId: string;
  harnessProfileId: string;
  verify: string[];
  protect: string[];
  protectExisting: string[];
  network: "inference_only" | "outbound";
  maxRepairs: number;
  dependencyFreshness: boolean;
  idempotencyKey?: string;
  dryRun: boolean;
}

export type JobsCommand =
  | { command: "help" }
  | { command: "probe" }
  | ({ command: "submit" } & SubmitOptions)
  | { command: "watch"; id: string }
  | { command: "patch"; id: string; index: number; attempt?: number; save?: string }
  | { command: "cancel"; id: string };

const HELP = { help: { type: "boolean", short: "h" } } as const;

function parse<O extends Record<string, { type: "boolean" | "string"; multiple?: boolean }>>(
  args: string[],
  options: O,
) {
  try {
    return parseArgs({ args, options: { ...options, ...HELP }, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function integer(name: string, value: string | undefined, min: number, max?: number) {
  if (value === undefined) return undefined;
  const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    const range = max === undefined ? `${min} or more` : `${min} to ${max}`;
    throw new UsageError(`${name} must be a whole number, ${range}.`);
  }
  return parsed;
}

function required(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new UsageError(`${name} is required.`);
  return value;
}

function jobId(positionals: string[], command: string): string {
  if (positionals.length !== 1 || !positionals[0].trim())
    throw new UsageError(`jobs ${command} takes one job id.`);
  return positionals[0];
}

/** A protected path is relative to the job's working directory, as Poundlock requires. */
function protectedPath(flag: string, value: string): string {
  const segments = value.split(/[\\/]/);
  if (!value.trim() || value.startsWith("/") || /^[A-Za-z]:/.test(value) || segments.includes(".."))
    throw new UsageError(`${flag} takes a path inside the folder, such as src/lib: ${value}`);
  return value;
}

export function parseJobsArgs(argv: string[]): JobsCommand {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h")
    return { command: "help" };
  switch (command) {
    case "probe": {
      const { positionals, values } = parse(rest, {});
      if (values.help) return { command: "help" };
      if (positionals.length) throw new UsageError("jobs probe takes no arguments.");
      return { command: "probe" };
    }
    case "submit": {
      const { positionals, values } = parse(rest, {
        dir: { type: "string" },
        "prompt-file": { type: "string" },
        "model-profile-id": { type: "string" },
        "harness-profile-id": { type: "string" },
        verify: { type: "string", multiple: true },
        protect: { type: "string", multiple: true },
        "protect-existing": { type: "string", multiple: true },
        network: { type: "string" },
        "max-repairs": { type: "string" },
        "dependency-freshness": { type: "boolean" },
        "idempotency-key": { type: "string" },
        "dry-run": { type: "boolean" },
      });
      if (values.help) return { command: "help" };
      if (positionals.length) throw new UsageError("jobs submit takes options only.");
      // A dry run reaches no controller and sends no task, so it needs neither.
      const dry = values["dry-run"] ?? false;
      const unlessDry = (name: string, value: string | undefined) =>
        dry ? (value ?? "") : required(name, value);
      const network = values.network ?? "inference_only";
      if (network !== "inference_only" && network !== "outbound")
        throw new UsageError("--network must be inference_only or outbound.");
      const verify = values.verify ?? [];
      if (verify.some((entry) => !entry.trim())) throw new UsageError("--verify cannot be empty.");
      return {
        command: "submit",
        dir: required("--dir", values.dir),
        promptFile: unlessDry("--prompt-file", values["prompt-file"]),
        modelProfileId: unlessDry("--model-profile-id", values["model-profile-id"]),
        harnessProfileId: values["harness-profile-id"] ?? "pi",
        verify,
        protect: (values.protect ?? []).map((path) => protectedPath("--protect", path)),
        protectExisting: (values["protect-existing"] ?? []).map((path) =>
          protectedPath("--protect-existing", path),
        ),
        network,
        maxRepairs: integer("--max-repairs", values["max-repairs"], 0, 3) ?? 0,
        dependencyFreshness: values["dependency-freshness"] ?? false,
        idempotencyKey: values["idempotency-key"]?.trim() || undefined,
        dryRun: dry,
      };
    }
    case "watch":
    case "cancel": {
      const { positionals, values } = parse(rest, {});
      if (values.help) return { command: "help" };
      return { command, id: jobId(positionals, command) };
    }
    case "patch": {
      const { positionals, values } = parse(rest, {
        index: { type: "string" },
        attempt: { type: "string" },
        save: { type: "string" },
      });
      if (values.help) return { command: "help" };
      return {
        command: "patch",
        id: jobId(positionals, "patch"),
        index: integer("--index", values.index, 0) ?? 0,
        attempt: integer("--attempt", values.attempt, 1),
        save: values.save,
      };
    }
    default:
      throw new UsageError(`Unknown jobs command: ${command}`);
  }
}

export { displaySafe };

const FINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
const WATCH_INTERVAL_MS = 2_000;

export async function runJobs(argv: string[], deps: JobsDeps): Promise<number> {
  const { io } = deps;
  // Set once the connection is read; every write below goes through `say`/`warn`,
  // so nothing composed here can carry the token to a terminal, a pipe or a log.
  let token = "";
  const redact = (text: string) => (token ? text.split(token).join("[token redacted]") : text);
  const say = (text: string) => io.out(`${displaySafe(redact(text))}\n`);
  const warn = (text: string) => io.err(`${displaySafe(redact(text))}\n`);

  let command: JobsCommand;
  try {
    command = parseJobsArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    warn(`${error.message}\nRun "jobs --help" for usage.`);
    return 2;
  }
  if (command.command === "help") {
    // Asking for help succeeds; running `jobs` with nothing at all is a mistake.
    if (argv.length === 0) {
      io.err(JOBS_USAGE);
      return 2;
    }
    io.out(JOBS_USAGE);
    return 0;
  }

  try {
    if (command.command === "submit" && command.dryRun) return await dryRun(command, say);

    const connection = await savedConnection(deps);
    token = connection.token;
    const client = new PoundlockClient(connection.url, connection.token, deps.fetch);
    const context: Context = {
      client,
      deps,
      say,
      warn,
      url: client.baseUrl,
      token,
    };

    switch (command.command) {
      case "probe":
        return probe(await client.probe(), say, warn);
      case "submit":
        return await submit(command, context);
      case "watch":
        return await watch(command.id, context);
      case "patch":
        return await patch(command, context);
      case "cancel": {
        const result = await client.cancelJob(command.id);
        say(
          result.cancel_requested
            ? `Cancel requested for job ${command.id}.`
            : `The controller did not accept a cancel for job ${command.id}; it may already have finished.`,
        );
        return 0;
      }
    }
  } catch (error) {
    warn(failureText(error, command));
    return 1;
  }
}

interface Context {
  client: PoundlockClient;
  deps: JobsDeps;
  say(text: string): void;
  warn(text: string): void;
  url: string;
  token: string;
}

/**
 * The saved connection, or a refusal that names no file contents. A damaged
 * `connection.secret.json` makes `JSON.parse` quote the start of the file in its
 * message, and that file is the token.
 */
async function savedConnection(deps: JobsDeps): Promise<{ url: string; token: string }> {
  let connection: { url: string; token: string };
  try {
    connection = await deps.connection();
  } catch {
    throw new Error(
      `Could not read the saved Poundlock connection; the files in ${defaultConfigRoot()} may be damaged. Run /connect in the terminal client, or save the connection again in the Poundlock Dispatch desktop app.`,
    );
  }
  if (!connection.url.trim())
    throw new Error(
      "No Poundlock controller is saved. Run /connect in the terminal client, or set the connection in the Poundlock Dispatch desktop app (Settings, Connection); both share it.",
    );
  if (!connection.token.trim())
    throw new Error(
      "The saved connection has no token. Run /connect in the terminal client, or paste an application token in the Poundlock Dispatch desktop app (Settings, Connection).",
    );
  return { url: connection.url.trim(), token: connection.token.trim() };
}

function failureText(error: unknown, command: JobsCommand): string {
  if (error instanceof PoundlockError)
    return error.hint ? `${error.message}\n${error.hint}` : error.message;
  const message = error instanceof Error ? error.message : String(error);
  if (command.command === "watch")
    return `${message}\nThe job is not affected. Run "jobs watch ${command.id}" again to keep following it.`;
  return message;
}

function probe(result: ConnectionProbe, say: Context["say"], warn: Context["warn"]): number {
  say(`url: ${result.url}`);
  say(`ready: ${result.ready ? "yes" : "no"}`);
  if (result.version) say(`version: ${result.version}`);
  if (result.permissions.length) say(`permissions: ${result.permissions.join(", ")}`);
  const missingJobs = JOB_PERMISSIONS.filter((name) => !result.permissions.includes(name));
  if (missingJobs.length) say(`missing for jobs: ${missingJobs.map(permissionLabel).join(", ")}`);
  if (result.missingPermissions.length) {
    say(`missing for the app: ${result.missingPermissions.map(permissionLabel).join(", ")}`);
    say("These are not needed for the jobs commands; the Dispatch app uses them.");
  }
  say(`outbound network for jobs: ${result.outboundNetworkAllowed ? "allowed" : "not allowed"}`);
  if (result.durableModels.length) {
    say("job model profiles:");
    for (const model of result.durableModels)
      say(
        `  ${model.name} (${model.id})${model.data_destination ? `, ${model.data_destination}` : ""}${model.busy ? ", busy" : ""}`,
      );
  }
  if (result.harnesses.length) {
    say("harnesses:");
    for (const harness of result.harnesses)
      say(`  ${harness.name} (${harness.id}) ${harness.version}`);
  }
  const usable = result.ready && missingJobs.length === 0;
  if (!usable) {
    warn(result.error ?? "This token cannot run jobs.");
    if (result.hint) warn(result.hint);
  }
  return usable ? 0 : 1;
}

/**
 * Poundlock rejects a snapshot with no files; an empty project folder is
 * submitted as its dedicated empty workspace instead.
 */
function jobSource(
  snapshot: Array<{ path: string; content: Buffer; executable: boolean }>,
): SubmitJobInput["source"] {
  if (!snapshot.length) return { kind: "empty" };
  return {
    kind: "snapshot",
    files: snapshot.map((file) => ({
      path: file.path,
      content_base64: file.content.toString("base64"),
      executable: file.executable,
    })),
  };
}

async function snapshotOf(options: SubmitOptions) {
  const info = await stat(options.dir).catch(() => undefined);
  if (!info?.isDirectory()) throw new Error(`${options.dir} is not a folder.`);
  const files = await collectLiveSnapshot(options.dir);
  if (!files.length)
    throw new Error(
      `Nothing to upload: every file in ${options.dir} is excluded by .gitignore or the built-in secrets list.`,
    );
  return files;
}

async function dryRun(options: SubmitOptions, say: Context["say"]): Promise<number> {
  const files = await snapshotOf(options);
  for (const file of files) say(`${file.path}  ${file.content.byteLength} bytes`);
  const bytes = files.reduce((total, file) => total + file.content.byteLength, 0);
  say(`${files.length} files, ${bytes} bytes would be uploaded. Nothing was sent.`);
  return 0;
}

function policyFor(options: SubmitOptions): NonNullable<SubmitJobInput["policy"]> {
  return {
    verification: {
      commands: options.verify.map((command) => ({ command })),
      protected_paths: [
        ...options.protect,
        ...options.protectExisting.map((path) => ({ path, mode: "existing_only" as const })),
      ],
    },
    network: options.network,
    max_repairs: options.maxRepairs,
    ...(options.dependencyFreshness ? { dependency_freshness: true } : {}),
  };
}

async function submit(options: SubmitOptions, context: Context): Promise<number> {
  const prompt = (await readFile(options.promptFile, "utf8").catch(() => undefined))?.trim();
  if (!prompt) throw new Error(`${options.promptFile} is missing or empty.`);
  const files = await snapshotOf(options);
  const bytes = files.reduce((total, file) => total + file.content.byteLength, 0);
  const input: SubmitJobInput = {
    idempotencyKey: options.idempotencyKey ?? "",
    modelProfileId: options.modelProfileId,
    harnessProfileId: options.harnessProfileId,
    prompt,
    source: jobSource(files),
    policy: policyFor(options),
  };
  // Poundlock hashes the whole request, so a resubmit that changes only the policy
  // is a different job and must not collide with the first.
  if (!options.idempotencyKey) input.idempotencyKey = `dispatch-cli:${requestHash(input)}`;
  context.warn(`Uploading ${files.length} files, ${bytes} bytes, to ${context.url}.`);
  let job: PoundlockJob;
  try {
    job = await context.client.submitJob(input);
  } catch (error) {
    if (error instanceof PoundlockError) throw error;
    // The request may have been accepted before the connection dropped.
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${reason}\nThe controller may or may not have received the job. Run the same command again: the same input carries the same key, so it will not start a second job.`,
    );
  }
  context.say(job.id);
  return 0;
}

async function watch(id: string, context: Context): Promise<number> {
  const sleep =
    context.deps.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  // The controller returns events with a sequence strictly greater than `after`,
  // so the cursor is the last sequence seen. The old CLI stepped it one further
  // and could skip an event.
  let after = 0;
  while (true) {
    for (const event of await context.client.jobEvents(id, after)) {
      context.say(`[${event.kind}] ${event.message}`);
      after = Math.max(after, event.sequence);
    }
    const job = await context.client.getJob(id);
    if (FINAL_STATUSES.has(job.status)) return report(job, context);
    await sleep(WATCH_INTERVAL_MS);
  }
}

/** The wall-clock budget a running job has left, once a runner has claimed it. */
export function wallTimeLeft(deadlineAt: string | null | undefined, now: Date): string {
  if (typeof deadlineAt !== "string" || !deadlineAt) return "not yet claimed by a runner";
  const remaining = new Date(deadlineAt).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return "unknown";
  if (remaining <= 0) return "deadline passed";
  const minutes = Math.ceil(remaining / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
}

/**
 * The job's output as a person reads it. Pi's harness output is its JSON event
 * stream; from that only the agent's last reply is shown, since the events are
 * already printed as they happen. Anything else is shown as it is.
 */
export function readableOutput(output: string): string {
  const text = output.trim();
  if (!text.startsWith("{")) return text;
  let reply: string | undefined;
  for (const line of text.split("\n")) {
    let event: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    const content = event.message.content;
    const said = Array.isArray(content)
      ? content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("")
          .trim()
      : "";
    if (said) reply = said;
  }
  return reply ?? text;
}

function report(job: PoundlockJob, context: Context): number {
  const { say } = context;
  const result = parseJobResult(job);
  say(`job: ${job.id}`);
  say(`status: ${job.status}`);
  say(`attempt: ${job.attempt_id}`);
  say(`model profile: ${job.model_profile_id}`);
  say(`harness profile: ${job.harness_profile_id}`);
  if (typeof job.wall_seconds === "number") say(`wall seconds: ${job.wall_seconds}`);
  if (job.deadline_at)
    say(`wall time: ${wallTimeLeft(job.deadline_at, (context.deps.now ?? (() => new Date()))())}`);
  if (job.error)
    say(`error: ${typeof job.error === "string" ? job.error : JSON.stringify(job.error)}`);
  if (result.verification) {
    say(
      `checks: ${result.verification.status}${result.verification.reason ? `, ${result.verification.reason}` : ""}`,
    );
    for (const check of result.verification.commands)
      say(`  ${check.exitCode === 0 ? "passed" : "failed"}: ${check.command}`);
    if (result.verification.changedProtectedPaths?.length)
      say(`changed protected paths: ${result.verification.changedProtectedPaths.join(", ")}`);
  }
  say(`patches: ${result.patches.length}`);
  result.patches.forEach((patch, index) => {
    say(
      `  ${index}: ${patch.root || "."} ${Buffer.byteLength(patch.patch)} bytes sha256 ${patch.sha256}`,
    );
  });
  const output = readableOutput(result.output);
  if (output) say(`\noutput:\n${output}`);
  return job.status === "completed" && !verificationFailed(result.verification) ? 0 : 1;
}

async function patch(
  options: Extract<JobsCommand, { command: "patch" }>,
  context: Context,
): Promise<number> {
  const text = await context.client.downloadPatch(options.id, options.index, options.attempt);
  // A patch is exact bytes, and `git apply` would reject an edited one, so it is
  // never redacted. One that holds the token is refused instead.
  if (context.token && text.includes(context.token))
    throw new Error("The patch contains the saved token, so it was not written or printed.");
  if (options.save) {
    await writeFile(options.save, text);
    context.say(`Patch saved to ${options.save}.`);
    return 0;
  }
  // A terminal gets it made safe; a pipe or file gets the exact patch.
  context.deps.io.out(context.deps.io.outIsTty ? displaySafe(text) : text);
  return 0;
}
