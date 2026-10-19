/**
 * `poundlock-dispatch-tui jobs ...`, driven against a stand-in controller.
 *
 * What matters here is what leaves the machine and what reaches the terminal:
 * the upload must be free of secrets whatever the project's `.gitignore` says,
 * and neither the saved token nor anything a job wrote may end up where it
 * should not. Argument parsing is covered because a wrong flag on `submit`
 * would otherwise upload the wrong folder.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { FileStore } from "@core/store";
import { main } from "@tui/index";
import {
  displaySafe,
  JOBS_USAGE,
  type JobsDeps,
  parseJobsArgs,
  runJobs,
  UsageError,
  wallTimeLeft,
} from "@tui/jobs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { tempDir } from "./support/temp-dir";

const TOKEN = "plt_test_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
const URL = "https://poundlock.example";
const SECRET = "sk-live-DO-NOT-UPLOAD-1234567890";

/** Characters a terminal acts on, written as code points so they are visible in source. */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CSI = String.fromCharCode(0x9b);
const RLO = String.fromCharCode(0x202e);
const GONE = String.fromCharCode(0xfffd);

interface Seen {
  method: string;
  url: string;
  authorization: string | null;
  body: string;
}

type Handler = (seen: Seen) => Response | Promise<Response>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A controller that answers by `METHOD /path` and remembers everything it was sent. */
function controller(routes: Record<string, Handler>) {
  const requests: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const seen: Seen = {
      method,
      url,
      authorization: new Headers(init?.headers).get("authorization"),
      body: typeof init?.body === "string" ? init.body : "",
    };
    requests.push(seen);
    const path = url.slice(URL.length).split("?")[0];
    const handler = routes[`${method} ${path}`];
    return handler
      ? handler(seen)
      : json({ error: { message: `unexpected ${method} ${path}` } }, 500);
  }) as typeof fetch;
  return { fetch: fetchImpl, requests };
}

function harness(routes: Record<string, Handler> = {}, options: { tty?: boolean } = {}) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const server = controller(routes);
  const sleeps: number[] = [];
  const connection = vi.fn(async () => ({ url: URL, token: TOKEN }));
  const deps: JobsDeps = {
    connection,
    fetch: server.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    now: () => new Date("2026-09-29T12:00:00Z"),
    io: {
      out: (text) => void stdout.push(text),
      err: (text) => void stderr.push(text),
      outIsTty: options.tty ?? false,
    },
  };
  return {
    deps,
    connection,
    requests: server.requests,
    sleeps,
    run: (...argv: string[]) => runJobs(argv, deps),
    out: () => stdout.join(""),
    err: () => stderr.join(""),
    everything: () => stdout.join("") + stderr.join(""),
  };
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

/** A project with credentials in it, and (optionally) a `.gitignore` that never names them. */
async function project(gitignore?: string): Promise<string> {
  const root = await tempDir("dispatch-jobs-");
  await put(root, "src/index.ts", "export const one = 1;\n");
  await put(root, "README.md", "# demo\n");
  await put(root, ".env.example", "API_KEY=\n");
  for (const secret of [".env", ".env.local", "config/secrets.json", "apps/web/.env"])
    await put(root, secret, `${SECRET}\n`);
  if (gitignore !== undefined) await put(root, ".gitignore", gitignore);
  return root;
}

async function promptFile(text = "Add a second export.\n"): Promise<string> {
  const root = await tempDir("dispatch-prompt-");
  await put(root, "task.md", text);
  return join(root, "task.md");
}

const submitted = (requests: Seen[]) => requests.find((seen) => seen.url.endsWith("/api/v1/jobs"));

/** Every path and every decoded byte in the upload, however it was encoded. */
function uploadOf(seen: Seen) {
  const body = JSON.parse(seen.body) as {
    source: { kind: string; files: Array<{ path: string; content_base64: string }> };
    idempotency_key: string;
    policy: Record<string, unknown> & {
      verification: { commands: unknown[]; protected_paths: unknown[] };
    };
  };
  const files = body.source.files;
  return {
    body,
    paths: files.map((file) => file.path),
    contents: files.map((file) => Buffer.from(file.content_base64, "base64").toString("utf8")),
  };
}

const accept: Record<string, Handler> = {
  "POST /api/v1/jobs": () => json({ id: "job_123", status: "pending" }, 201),
};

describe("jobs argument parsing", () => {
  const submit = (...extra: string[]) => [
    "submit",
    "--dir",
    "./proj",
    "--prompt-file",
    "task.md",
    "--model-profile-id",
    "coder",
    ...extra,
  ];

  it("reads a full submit", () => {
    const parsed = parseJobsArgs(
      submit(
        "--verify",
        "npm test",
        "--verify",
        "npm run lint",
        "--protect",
        "tests",
        "--protect-existing",
        ".venv",
        "--network",
        "outbound",
        "--max-repairs",
        "2",
        "--dependency-freshness",
      ),
    );
    expect(parsed).toMatchObject({
      command: "submit",
      dir: "./proj",
      promptFile: "task.md",
      modelProfileId: "coder",
      harnessProfileId: "pi",
      verify: ["npm test", "npm run lint"],
      protect: ["tests"],
      protectExisting: [".venv"],
      network: "outbound",
      maxRepairs: 2,
      dependencyFreshness: true,
      dryRun: false,
    });
  });

  it("defaults to the least network and no repairs", () => {
    expect(parseJobsArgs(submit())).toMatchObject({
      network: "inference_only",
      maxRepairs: 0,
      dependencyFreshness: false,
    });
  });

  it("never defaults the folder to upload", () => {
    expect(() =>
      parseJobsArgs(["submit", "--prompt-file", "t.md", "--model-profile-id", "coder"]),
    ).toThrow(/--dir is required/);
  });

  it("needs no prompt or model to list a dry run", () => {
    expect(parseJobsArgs(["submit", "--dir", ".", "--dry-run"])).toMatchObject({ dryRun: true });
  });

  it.each([
    [["submit", "--dir", ".", "--prompt-file", "t"], /--model-profile-id is required/],
    [submit("--network", "open"), /--network must be/],
    [submit("--max-repairs", "4"), /--max-repairs must be a whole number, 0 to 3/],
    [submit("--max-repairs", "-1"), /--max-repairs/],
    [submit("--max-repairs", "1.5"), /--max-repairs/],
    [submit("--protect", "../outside"), /inside the folder/],
    [submit("--protect", "/etc"), /inside the folder/],
    [submit("--protect-existing", "a/../../b"), /inside the folder/],
    [submit("--verify", " "), /--verify cannot be empty/],
    [submit("--token", "abc"), /Unknown option '--token'/],
    [submit("stray"), /takes options only/],
    [["watch"], /takes one job id/],
    [["watch", "a", "b"], /takes one job id/],
    [["patch", "job", "--attempt", "0"], /--attempt must be a whole number, 1 or more/],
    [["patch", "job", "--index", "x"], /--index/],
    [["probe", "extra"], /takes no arguments/],
    [["launch"], /Unknown jobs command: launch/],
  ])("rejects %j", (argv, message) => {
    expect(() => parseJobsArgs(argv)).toThrow(UsageError);
    expect(() => parseJobsArgs(argv)).toThrow(message);
  });

  it("never accepts the token on the command line", () => {
    for (const argv of [
      submit("--token", "x"),
      ["probe", "--token", "x"],
      ["probe", "--token-file", "x"],
    ])
      expect(() => parseJobsArgs(argv)).toThrow(UsageError);
  });

  it("recognises help anywhere a command takes options", () => {
    for (const argv of [
      ["help"],
      ["--help"],
      ["submit", "--help"],
      ["watch", "--help"],
      ["patch", "-h"],
    ])
      expect(parseJobsArgs(argv)).toEqual({ command: "help" });
  });
});

describe("jobs exit codes and help", () => {
  it("prints usage and exits 2 when run with nothing", async () => {
    const h = harness();
    expect(await h.run()).toBe(2);
    expect(h.err()).toBe(JOBS_USAGE);
    expect(h.out()).toBe("");
  });

  it("prints usage to stdout and exits 0 when asked", async () => {
    const h = harness();
    expect(await h.run("--help")).toBe(0);
    expect(h.out()).toBe(JOBS_USAGE);
    expect(h.err()).toBe("");
    expect(h.connection).not.toHaveBeenCalled();
  });

  it("exits 2 on a usage mistake without reading the connection", async () => {
    const h = harness();
    expect(await h.run("submit", "--dir")).toBe(2);
    expect(h.err()).toContain('Run "jobs --help"');
    expect(h.connection).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  });
});

describe("jobs submit", () => {
  it("uploads a project with no .gitignore without its secrets, and keeps .env.example", async () => {
    const h = harness(accept);
    const dir = await project();
    expect(
      await h.run(
        "submit",
        "--dir",
        dir,
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(0);

    const request = submitted(h.requests);
    expect(request).toBeDefined();
    const upload = uploadOf(request as Seen);
    expect(upload.paths.sort()).toEqual([".env.example", "README.md", "src/index.ts"]);
    for (const gone of [".env", ".env.local", "config/secrets.json", "apps/web/.env"])
      expect(upload.paths).not.toContain(gone);
    // Whatever the paths say, no byte of a secret may be in the body, encoded or not.
    expect(upload.contents.join("\n")).not.toContain(SECRET);
    expect((request as Seen).body).not.toContain(Buffer.from(SECRET).toString("base64"));
    expect((request as Seen).body).not.toContain(SECRET);
    expect(h.out()).toBe("job_123\n");
  });

  it("still leaves them out when .gitignore says nothing about them", async () => {
    const h = harness(accept);
    const dir = await project("node_modules/\n*.log\n");
    expect(
      await h.run(
        "submit",
        "--dir",
        dir,
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(0);
    const upload = uploadOf(submitted(h.requests) as Seen);
    expect(upload.paths).not.toEqual(expect.arrayContaining([".env"]));
    expect(upload.paths).not.toContain("config/secrets.json");
    expect(upload.paths).toContain(".env.example");
  });

  it("leaves them out when only root-anchored rules name them, which broke the old CLI", async () => {
    const h = harness(accept);
    const dir = await project("/.env\n/.env.local\n/config/secrets.json\n/private-notes.txt\n");
    await put(dir, "private-notes.txt", "mine\n");
    await put(dir, "pkg/private-notes.txt", "not the anchored one\n");
    expect(
      await h.run(
        "submit",
        "--dir",
        dir,
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(0);
    const upload = uploadOf(submitted(h.requests) as Seen);
    expect(upload.paths).not.toContain(".env");
    expect(upload.paths).not.toContain("config/secrets.json");
    expect(upload.paths).not.toContain("private-notes.txt");
    expect(upload.paths).toContain("pkg/private-notes.txt");
    expect(upload.paths).toContain(".env.example");
    expect(upload.contents.join("\n")).not.toContain(SECRET);
  });

  it("sends the policy the flags asked for, and least network by default", async () => {
    const h = harness(accept);
    const dir = await project();
    await h.run(
      "submit",
      "--dir",
      dir,
      "--prompt-file",
      await promptFile(),
      "--model-profile-id",
      "coder",
      "--verify",
      "npm test",
      "--protect",
      "tests",
      "--protect-existing",
      ".venv",
      "--max-repairs",
      "2",
      "--dependency-freshness",
    );
    const { body } = uploadOf(submitted(h.requests) as Seen);
    expect(body.policy).toEqual({
      verification: {
        commands: [{ command: "npm test" }],
        protected_paths: ["tests", { path: ".venv", mode: "existing_only" }],
      },
      network: "inference_only",
      max_repairs: 2,
      dependency_freshness: true,
    });
    expect(body).toMatchObject({
      model_profile_id: "coder",
      harness_profile_id: "pi",
      prompt: "Add a second export.",
    });
  });

  it("derives one key from the whole input, so a policy change is a different job", async () => {
    const keys: string[] = [];
    const dir = await project();
    const prompt = await promptFile();
    for (const extra of [[], [], ["--verify", "npm test"], ["--idempotency-key", "mine-1"]]) {
      const h = harness(accept);
      await h.run(
        "submit",
        "--dir",
        dir,
        "--prompt-file",
        prompt,
        "--model-profile-id",
        "coder",
        ...extra,
      );
      keys.push(uploadOf(submitted(h.requests) as Seen).body.idempotency_key);
    }
    expect(keys[0]).toMatch(/^dispatch-cli:[0-9a-f]{64}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
    expect(keys[3]).toBe("mine-1");
  });

  it("sends the token to the controller as a bearer credential, and only there", async () => {
    const h = harness(accept);
    await h.run(
      "submit",
      "--dir",
      await project(),
      "--prompt-file",
      await promptFile(),
      "--model-profile-id",
      "coder",
    );
    expect(h.requests.map((seen) => seen.authorization)).toEqual([`Bearer ${TOKEN}`]);
    expect(h.requests.map((seen) => seen.body).join("")).not.toContain(TOKEN);
    expect(h.requests.map((seen) => seen.url).join("")).not.toContain(TOKEN);
  });

  it("refuses to start a job with nothing to upload", async () => {
    const h = harness(accept);
    const dir = await tempDir("dispatch-empty-");
    await put(dir, ".env", `${SECRET}\n`);
    expect(
      await h.run(
        "submit",
        "--dir",
        dir,
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(1);
    expect(h.err()).toContain("Nothing to upload");
    expect(h.requests).toEqual([]);
  });

  it("names a missing folder or prompt rather than uploading something else", async () => {
    const h = harness(accept);
    expect(
      await h.run(
        "submit",
        "--dir",
        "/no/such/folder",
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(1);
    expect(h.err()).toContain("is not a folder");
    expect(
      await h.run(
        "submit",
        "--dir",
        await project(),
        "--prompt-file",
        "/no/such/task.md",
        "--model-profile-id",
        "coder",
      ),
    ).toBe(1);
    expect(h.err()).toContain("missing or empty");
    expect(h.requests).toEqual([]);
  });

  it("lists what a dry run would upload, reads no connection and sends nothing", async () => {
    const h = harness(accept);
    const dir = await project("/.env\n");
    expect(await h.run("submit", "--dir", dir, "--dry-run")).toBe(0);
    expect(h.out()).toContain("src/index.ts");
    expect(h.out()).toContain(".env.example");
    expect(h.out()).toContain("4 files");
    for (const gone of [".env.local", "secrets.json"]) expect(h.out()).not.toContain(gone);
    expect(h.connection).not.toHaveBeenCalled();
    expect(h.requests).toEqual([]);
  });

  it("says a dropped connection may still have started the job, and that rerunning is safe", async () => {
    const h = harness({
      "POST /api/v1/jobs": () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(
      await h.run(
        "submit",
        "--dir",
        await project(),
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(1);
    expect(h.err()).toContain("may or may not have received the job");
  });

  it("shows the controller's reason and hint for a refusal", async () => {
    const h = harness({
      "POST /api/v1/jobs": () => json({ error: { message: "key reused", code: "conflict" } }, 409),
    });
    expect(
      await h.run(
        "submit",
        "--dir",
        await project(),
        "--prompt-file",
        await promptFile(),
        "--model-profile-id",
        "coder",
      ),
    ).toBe(1);
    expect(h.err()).toContain("key reused");
    expect(h.err()).toContain("same submission key was reused");
  });
});

describe("the token stays out of every output", () => {
  it("is redacted when a controller echoes it in an error", async () => {
    const h = harness({
      "GET /api/v1/jobs/job_1/events": () =>
        json({ error: { message: `bad credential ${TOKEN} for this request` } }, 401),
    });
    expect(await h.run("watch", "job_1")).toBe(1);
    expect(h.err()).toContain("bad credential [token redacted] for this request");
    expect(h.everything()).not.toContain(TOKEN);
  });

  it("is redacted from job output and events", async () => {
    const h = harness({
      "GET /api/v1/jobs/job_1/events": () =>
        json([{ sequence: 1, kind: "log", message: `env has ${TOKEN}`, job_id: "job_1" }]),
      "GET /api/v1/jobs/job_1": () =>
        json({ id: "job_1", status: "completed", result: { output: `saw ${TOKEN}`, patches: [] } }),
    });
    expect(await h.run("watch", "job_1")).toBe(0);
    expect(h.everything()).not.toContain(TOKEN);
    expect(h.out()).toContain("env has [token redacted]");
  });

  it("is not quoted back when the saved secret file is damaged", async () => {
    // JSON.parse quotes the start of a file it cannot read, and this file is the token.
    const config = await tempDir("dispatch-config-");
    await writeFile(join(config, "connection.json"), JSON.stringify({ url: URL, roles: {} }));
    await writeFile(join(config, "connection.secret.json"), TOKEN);
    const store = new FileStore(await tempDir("dispatch-data-"), config);
    await expect(store.getConnection()).rejects.toThrow(); // the reader it must not be trusted to word

    const h = harness();
    h.deps.connection = () => store.getConnection();
    expect(await h.run("probe")).toBe(1);
    expect(h.err()).toContain("Could not read the saved Poundlock connection");
    expect(h.everything()).not.toContain(TOKEN);
    expect(h.everything()).not.toContain(TOKEN.slice(0, 8)); // the part JSON.parse quotes
    expect(h.requests).toEqual([]);
  });

  it("is never printed when there is none, and the way to set one is named", async () => {
    for (const saved of [
      { url: "", token: TOKEN },
      { url: URL, token: "" },
    ]) {
      const h = harness();
      h.deps.connection = async () => saved;
      expect(await h.run("probe")).toBe(1);
      expect(h.err()).toContain("desktop app");
      expect(h.everything()).not.toContain(TOKEN);
      expect(h.requests).toEqual([]);
    }
  });

  it("is refused rather than printed or saved if a patch holds it", async () => {
    const dir = await tempDir("dispatch-patch-");
    const target = join(dir, "job.patch");
    const h = harness({
      "GET /api/v1/jobs/job_1/patches/0": () => new Response(`+token = ${TOKEN}\n`),
    });
    expect(await h.run("patch", "job_1")).toBe(1);
    expect(await h.run("patch", "job_1", "--save", target)).toBe(1);
    expect(h.everything()).not.toContain(TOKEN);
    await expect(readFile(target)).rejects.toThrow();
  });
});

describe("jobs watch", () => {
  /** A controller that honours `after` as Poundlock does: sequence strictly greater. */
  function stream(events: number, finalStatus = "completed", extra: Record<string, unknown> = {}) {
    const all = Array.from({ length: events }, (_, index) => ({
      sequence: 10 + index,
      job_id: "job_1",
      kind: "step",
      message: `event ${index + 1}`,
      payload: {},
      created_at: "2026-09-29T12:00:00Z",
    }));
    let polls = 0;
    return {
      "GET /api/v1/jobs/job_1/events": (seen: Seen) => {
        const after = Number(new globalThis.URL(seen.url).searchParams.get("after") ?? 0);
        // Two events per poll, so the cursor is exercised across polls.
        polls += 1;
        return json(all.filter((event) => event.sequence > after).slice(0, 2));
      },
      "GET /api/v1/jobs/job_1": () =>
        json({
          id: "job_1",
          status: polls * 2 >= events ? finalStatus : "running",
          attempt_id: "att_1",
          model_profile_id: "coder",
          harness_profile_id: "pi",
          ...extra,
        }),
    } satisfies Record<string, Handler>;
  }

  it("prints every event once, in order, however many polls it takes", async () => {
    const h = harness(stream(5));
    expect(await h.run("watch", "job_1")).toBe(0);
    const printed = h
      .out()
      .split("\n")
      .filter((line) => line.startsWith("[step]"));
    expect(printed).toEqual([1, 2, 3, 4, 5].map((n) => `[step] event ${n}`));
    expect(h.sleeps.length).toBeGreaterThan(0);
    expect(new Set(h.sleeps)).toEqual(new Set([2000]));
    // The cursor is the last sequence seen, not one past it.
    const afters = h.requests
      .filter((seen) => seen.url.includes("/events"))
      .map((seen) => new globalThis.URL(seen.url).searchParams.get("after"));
    expect(afters).toEqual([null, "11", "13"]);
  });

  it("summarises a finished job and exits 0", async () => {
    const h = harness(
      stream(2, "completed", {
        wall_seconds: 91,
        deadline_at: "2026-09-29T12:45:00Z",
        result: {
          output: "Added the export.",
          patches: [{ root: ".", base_revision: "abc", patch: "diff --git a/x b/x\n" }],
          provenance: {
            verification: { status: "passed", commands: [{ command: "npm test", exit_code: 0 }] },
          },
        },
      }),
    );
    expect(await h.run("watch", "job_1")).toBe(0);
    expect(h.out()).toContain("status: completed");
    expect(h.out()).toContain("wall seconds: 91");
    expect(h.out()).toContain("wall time: 45m left");
    expect(h.out()).toContain("checks: passed");
    expect(h.out()).toContain("passed: npm test");
    expect(h.out()).toContain("patches: 1");
    expect(h.out()).toContain("Added the export.");
  });

  it("shows only the agent's last reply from Pi's event stream", async () => {
    const events = [
      { type: "agent_start" },
      {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "toolCall", name: "write" }] },
      },
      {
        type: "message_end",
        message: { role: "toolResult", content: [{ type: "text", text: "wrote" }] },
      },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Done. All 4 tests pass." }],
        },
      },
      { type: "agent_end" },
    ];
    const h = harness(
      stream(1, "completed", {
        result: {
          output: `${events.map((event) => JSON.stringify(event)).join("\n")}\n[poundlock] omitted 3 events`,
          patches: [],
        },
      }),
    );
    expect(await h.run("watch", "job_1")).toBe(0);
    expect(h.out()).toContain("output:\nDone. All 4 tests pass.");
    expect(h.out()).not.toContain('"type"');
  });

  it.each(["failed", "cancelled"])("exits 1 when the job ends %s", async (status) => {
    const h = harness(stream(1, status, { error: "runner lost" }));
    expect(await h.run("watch", "job_1")).toBe(1);
    expect(h.out()).toContain(`status: ${status}`);
    expect(h.out()).toContain("error: runner lost");
  });

  it("exits 1 for a completed job whose checks failed", async () => {
    const h = harness(
      stream(1, "completed", {
        result: {
          patches: [],
          provenance: {
            verification: { status: "failed", commands: [{ command: "npm test", exit_code: 1 }] },
          },
        },
      }),
    );
    expect(await h.run("watch", "job_1")).toBe(1);
    expect(h.out()).toContain("failed: npm test");
  });

  it("says the job is unaffected when the connection drops mid-watch", async () => {
    const h = harness({
      "GET /api/v1/jobs/job_1/events": () => {
        throw new TypeError("fetch failed");
      },
    });
    expect(await h.run("watch", "job_1")).toBe(1);
    expect(h.err()).toContain('Run "jobs watch job_1" again');
  });

  it("does not let a job move the cursor or rewrite the screen with escape sequences", async () => {
    const h = harness({
      "GET /api/v1/jobs/job_1/events": () =>
        json([
          {
            sequence: 1,
            kind: "log",
            message: `ok${ESC}[2J${ESC}]52;c;ZXZpbA==${BEL}\rgone ${RLO}evil`,
          },
        ]),
      "GET /api/v1/jobs/job_1": () => json({ id: "job_1", status: "completed" }),
    });
    await h.run("watch", "job_1");
    for (const unsafe of [ESC, BEL, RLO, "\r"]) expect(h.out()).not.toContain(unsafe);
    expect(h.out()).toContain("[log] ok");
  });
});

describe("jobs patch", () => {
  const patchText =
    "diff --git a/a.txt b/a.txt\r\n--- a/a.txt\r\n+++ b/a.txt\r\n@@ -1 +1 @@\r\n-x\r\n+y\r\n";

  it("prints a patch to a pipe byte for byte, carriage returns included", async () => {
    const h = harness({ "GET /api/v1/jobs/job_1/patches/0": () => new Response(patchText) });
    expect(await h.run("patch", "job_1")).toBe(0);
    expect(h.out()).toBe(patchText);
  });

  it("makes a patch safe to print when stdout is a terminal", async () => {
    const h = harness(
      { "GET /api/v1/jobs/job_1/patches/0": () => new Response("+\u001b[2Jclear\n") },
      { tty: true },
    );
    expect(await h.run("patch", "job_1")).toBe(0);
    expect(h.out()).not.toContain("\u001b");
    expect(h.out()).toContain("clear");
  });

  it("passes the index and attempt, and saves exactly what it received", async () => {
    const target = join(await tempDir("dispatch-save-"), "out.patch");
    const h = harness({ "GET /api/v1/jobs/job_1/patches/2": () => new Response(patchText) });
    expect(await h.run("patch", "job_1", "--index", "2", "--attempt", "3", "--save", target)).toBe(
      0,
    );
    expect(h.requests[0].url).toBe(`${URL}/api/v1/jobs/job_1/patches/2?attempt=3`);
    expect(await readFile(target, "utf8")).toBe(patchText);
    expect(h.out()).toBe(`Patch saved to ${target}.\n`);
  });

  it("reports a missing patch as a failure", async () => {
    const h = harness({
      "GET /api/v1/jobs/job_1/patches/0": () => json({ error: { message: "no such patch" } }, 404),
    });
    expect(await h.run("patch", "job_1")).toBe(1);
    expect(h.err()).toContain("no such patch");
  });
});

describe("jobs cancel", () => {
  it("reports an accepted cancel", async () => {
    const h = harness({ "POST /api/v1/jobs/job_1/cancel": () => json({ cancel_requested: true }) });
    expect(await h.run("cancel", "job_1")).toBe(0);
    expect(h.out()).toBe("Cancel requested for job job_1.\n");
  });

  it("says so when the controller did not take it", async () => {
    const h = harness({
      "POST /api/v1/jobs/job_1/cancel": () => json({ cancel_requested: false }),
    });
    expect(await h.run("cancel", "job_1")).toBe(0);
    expect(h.out()).toContain("did not accept a cancel");
  });

  it("escapes the id rather than letting it rewrite the path", async () => {
    const h = harness({});
    await h.run("cancel", "../admin");
    expect(h.requests[0].url).toBe(`${URL}/api/v1/jobs/..%2Fadmin/cancel`);
  });
});

describe("jobs probe", () => {
  function ready(
    permissions: string[],
    extra: Record<string, Handler> = {},
  ): Record<string, Handler> {
    return {
      "GET /readyz": () => json({ status: "ready", version: "0.1.2" }),
      "GET /api/v1/job-options": () =>
        json({
          role: "developer",
          permissions,
          models: [
            {
              id: "m1",
              name: "coder",
              data_destination: "operator_network",
              busy: true,
              aliases: [],
            },
          ],
          harnesses: [{ id: "pi", name: "Pi", kind: "pi", version: "1.0.0" }],
          git_hosts: [],
          outbound_network_allowed: true,
          source_limits: { bytes: 1, files: 1 },
        }),
      "GET /v1/models": () => json({ error: { message: "no" } }, 401),
      "GET /api/v1/usage": () => json({ error: { message: "no" } }, 401),
      "POST /v1/chat/completions": () => json({ error: { message: "no" } }, 401),
      ...extra,
    };
  }

  it("succeeds for a token that can run jobs, and says what it found", async () => {
    const h = harness(ready(["jobs:read", "jobs:submit", "jobs:cancel"]));
    expect(await h.run("probe")).toBe(0);
    expect(h.out()).toContain(`url: ${URL}`);
    expect(h.out()).toContain("ready: yes");
    expect(h.out()).toContain("version: 0.1.2");
    expect(h.out()).toContain("coder (m1), operator_network, busy");
    expect(h.out()).toContain("Pi (pi) 1.0.0");
    expect(h.out()).toContain("outbound network for jobs: allowed");
    // Not needed for jobs, so it is said and does not fail the probe.
    expect(h.out()).toContain("not needed for the jobs commands");
    expect(h.everything()).not.toContain(TOKEN);
  });

  it("fails and names the permission a jobs token lacks", async () => {
    const h = harness(ready(["jobs:read"]));
    expect(await h.run("probe")).toBe(1);
    expect(h.out()).toContain("Submit jobs with supplied files");
    expect(h.err()).toContain("cannot run");
  });

  it("fails when the controller cannot be reached", async () => {
    const h = harness();
    h.deps.fetch = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
    }) as typeof fetch;
    expect(await h.run("probe")).toBe(1);
    expect(h.err()).toContain(`Could not reach ${URL}`);
  });
});

describe("terminal safety helpers", () => {
  it("keeps newlines and tabs, and removes what a terminal would act on", () => {
    expect(displaySafe("a\tb\nc\r\nd")).toBe("a\tb\nc\nd");
    expect(displaySafe(`x${ESC}[31my${BEL}z\ru`)).toBe(`x${GONE}[31my${GONE}z${GONE}u`);
    expect(displaySafe(`${CSI}31m`)).toBe(`${GONE}31m`);
  });

  it("reads the wall-clock budget from the deadline", () => {
    const now = new Date("2026-09-29T12:00:00Z");
    expect(wallTimeLeft(null, now)).toBe("not yet claimed by a runner");
    expect(wallTimeLeft("2026-09-29T11:59:00Z", now)).toBe("deadline passed");
    expect(wallTimeLeft("2026-09-29T12:10:30Z", now)).toBe("11m left");
    expect(wallTimeLeft("2026-09-29T14:05:00Z", now)).toBe("2h 5m left");
    expect(wallTimeLeft("not a date", now)).toBe("unknown");
  });
});

describe("the terminal binary", () => {
  const saved = {
    config: process.env.POUNDLOCK_CONFIG_DIR,
    data: process.env.POUNDLOCK_DISPATCH_DATA_DIR,
  };
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    for (const [key, value] of [
      ["POUNDLOCK_CONFIG_DIR", saved.config],
      ["POUNDLOCK_DISPATCH_DATA_DIR", saved.data],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("routes `jobs` to the job commands, reading the shared connection and nothing else", async () => {
    process.env.POUNDLOCK_CONFIG_DIR = await tempDir("dispatch-empty-config-");
    process.env.POUNDLOCK_DISPATCH_DATA_DIR = await tempDir("dispatch-empty-data-");
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    await main(["jobs", "probe"]);
    expect(process.exitCode).toBe(1);
    expect(stderr.join("")).toContain("No Poundlock controller is saved");
  });

  it("reads the connection from the shared config directory", async () => {
    const config = await tempDir("dispatch-shared-config-");
    process.env.POUNDLOCK_CONFIG_DIR = config;
    process.env.POUNDLOCK_DISPATCH_DATA_DIR = await tempDir("dispatch-shared-data-");
    await writeFile(
      join(config, "connection.json"),
      JSON.stringify({ url: "http://127.0.0.1:9", roles: {} }),
    );
    await writeFile(join(config, "connection.secret.json"), JSON.stringify({ token: TOKEN }));
    const written: string[] = [];
    for (const stream of [process.stdout, process.stderr])
      vi.spyOn(stream, "write").mockImplementation((chunk) => {
        written.push(String(chunk));
        return true;
      });
    await main(["jobs", "probe"]);
    // Nothing listens on port 9, so this is a failure; what matters is that it tried the saved URL.
    expect(process.exitCode).toBe(1);
    expect(written.join("")).toContain("http://127.0.0.1:9");
    expect(written.join("")).not.toContain(TOKEN);
  });
});
