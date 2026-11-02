/** The `jobs` command line: its usage text and what each command was asked to do. */

import { parseArgs } from "node:util";

export const JOBS_USAGE = `Usage: dispatch jobs <command> [options]

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
