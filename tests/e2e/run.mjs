// End-to-end: Dispatch against a disposable Poundlock with a scripted model.
//
//   POUNDLOCK_IMAGE=<image> node tests/e2e/run.mjs [--report FILE] [--keep]
//
// Starts tests/e2e/compose.yaml as a fresh project on the current Docker host,
// configures Poundlock as an operator would (one direct model server, no LiteLLM,
// an application token), then checks the terminal client's connection test, the
// manual durable-job commands (submit, replay, watch, patch, cancel), and an
// attached task: the Dispatch orchestrator with a real Pi worker writing into a
// project folder through Poundlock's inference API (tests/live-dispatch-use-cases
// U1 and U2). Every model answer comes from tests/e2e/mock_model.py. Build the
// terminal client first (npm run tui:build).
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const reportAt = args.indexOf("--report");
const keep = args.includes("--keep") || args.includes("--setup-only");
// --setup-only: configure the stack, print its address and token, leave it running.
const setupOnly = args.includes("--setup-only");
const image = process.env.POUNDLOCK_IMAGE;
if (!image) throw new Error("Set POUNDLOCK_IMAGE to the Poundlock image under test.");
const project = `dispatch-e2e-${randomBytes(4).toString("hex")}`;
const results = [];
const env = { ...process.env, POUNDLOCK_IMAGE: image };
env.POUNDLOCK_DOCKER_GID = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--entrypoint",
    "stat",
    "-v",
    "/var/run/docker.sock:/var/run/docker.sock:ro",
    image,
    "-c",
    "%g",
    "/var/run/docker.sock",
  ],
  { encoding: "utf8" },
).trim();

function compose(...rest) {
  const result = spawnSync(
    "docker",
    ["compose", "-p", project, "-f", join(here, "compose.yaml"), ...rest],
    {
      env,
      encoding: "utf8",
      timeout: 600_000,
    },
  );
  if (result.status !== 0) throw new Error(`compose ${rest[0]}: ${result.stderr.slice(-3000)}`);
  return result.stdout;
}

async function check(name, body) {
  const started = Date.now();
  try {
    const detail = (await body()) ?? "";
    results.push({ check: name, result: "PASS", detail, seconds: (Date.now() - started) / 1000 });
  } catch (error) {
    results.push({
      check: name,
      result: "FAIL",
      detail: String(error?.message ?? error),
      seconds: (Date.now() - started) / 1000,
    });
  }
  const last = results.at(-1);
  console.log(`${last.result}: ${name} ${last.detail}`.slice(0, 400));
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

let base;
let admin;
async function api(method, path, token, body) {
  const response = await fetch(base + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { status: response.status, value };
}

function cli(config, data, ...rest) {
  return spawnSync(process.execPath, [join(root, "out/tui/index.js"), ...rest], {
    env: {
      ...process.env,
      POUNDLOCK_CONFIG_DIR: config,
      POUNDLOCK_DISPATCH_DATA_DIR: data,
      NO_COLOR: "1",
    },
    encoding: "utf8",
    timeout: 400_000,
  });
}

try {
  compose("up", "-d", "--wait", "--wait-timeout", "180");
  base = `http://${compose("port", "controller", "7331").trim()}`;
  admin = compose("exec", "-T", "controller", "cat", "/data/admin-token").trim();
  const state = {};

  await check("operator configures one direct model server and an application token", async () => {
    const endpoint = await api("POST", "/api/v1/endpoints", admin, {
      name: "Scripted model server",
      kind: "openai",
      base_url: "http://mock-model:8080/v1",
      api_key: "",
      data_destination: "operator_network",
    });
    expect(
      endpoint.status === 200,
      `endpoint ${endpoint.status} ${JSON.stringify(endpoint.value)}`,
    );
    for (const [name, model, uses] of [["worker", "mock-coder", ["interactive", "durable"]]]) {
      const profile = await api("POST", "/api/v1/model-profiles", admin, {
        name,
        endpoint_id: endpoint.value.id,
        model_id: model,
        context_tokens: 16384,
        max_output_tokens: 1024,
        uses,
        wake_policy: "never",
        node_id: null,
        runtime_profile: null,
      });
      expect(
        profile.status === 200,
        `profile ${name} ${profile.status} ${JSON.stringify(profile.value)}`,
      );
      state[name] = profile.value.id;
    }
    const token = await api("POST", "/api/v1/api-tokens", admin, {
      name: "dispatch-e2e",
      permissions: ["models:read", "inference:invoke", "jobs:read", "jobs:submit", "jobs:cancel"],
    });
    expect(token.status === 200 && token.value.token, `token ${token.status}`);
    state.token = token.value.token;
    state.config = mkdtempSync(join(tmpdir(), "dispatch-e2e-config-"));
    state.data = mkdtempSync(join(tmpdir(), "dispatch-e2e-data-"));
    writeFileSync(join(state.config, "connection.json"), JSON.stringify({ url: base, roles: {} }));
    writeFileSync(
      join(state.config, "connection.secret.json"),
      JSON.stringify({ token: state.token }),
      { mode: 0o600 },
    );
  });

  if (setupOnly) {
    console.log(
      JSON.stringify({
        project,
        url: base,
        token: state.token,
        worker: state.worker,
        config: state.config,
      }),
    );
    process.exit(results.every((r) => r.result === "PASS") ? 0 : 1);
  }
  await check("the terminal client's connection test accepts the controller", async () => {
    const probe = cli(state.config, state.data, "jobs", "probe");
    expect(probe.status === 0, `exit ${probe.status}: ${probe.stdout}${probe.stderr}`);
    return probe.stdout.trim().split("\n").slice(0, 3).join(" | ");
  });

  await check("a manual durable job: submit, replay, watch, patch", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dispatch-e2e-job-"));
    writeFileSync(join(folder, "greeting.txt"), "Hello!\n");
    const prompt = join(state.data, "task.md");
    writeFileSync(prompt, "Update greeting.txt to greet the reader.\n");
    const submit = cli(
      state.config,
      state.data,
      "jobs",
      "submit",
      "--dir",
      folder,
      "--prompt-file",
      prompt,
      "--model-profile-id",
      state.worker,
    );
    expect(submit.status === 0, `submit exit ${submit.status}: ${submit.stderr}`);
    const id = submit.stdout.trim().split(/\s+/).at(-1);
    const again = cli(
      state.config,
      state.data,
      "jobs",
      "submit",
      "--dir",
      folder,
      "--prompt-file",
      prompt,
      "--model-profile-id",
      state.worker,
    );
    expect(
      again.stdout.trim().split(/\s+/).at(-1) === id,
      "an identical resubmission made a second job",
    );
    const watch = cli(state.config, state.data, "jobs", "watch", id);
    expect(
      watch.status === 0,
      `watch exit ${watch.status}: ${watch.stdout.slice(-800)}${watch.stderr}`,
    );
    const saved = join(state.data, "job.patch");
    const patch = cli(state.config, state.data, "jobs", "patch", id, "--save", saved);
    expect(patch.status === 0, `patch exit ${patch.status}: ${patch.stderr}`);
    expect(
      readFileSync(saved, "utf8").includes("Hello, reader."),
      "the patch does not carry the change",
    );
    expect(
      readFileSync(join(folder, "greeting.txt"), "utf8") === "Hello!\n",
      "the job changed the local folder",
    );
    state.job = id;
    return `job ${id}`;
  });

  await check("a cancelled durable job is reported as cancelled", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dispatch-e2e-cancel-"));
    writeFileSync(join(folder, "greeting.txt"), "Hi!\n");
    const prompt = join(state.data, "cancel.md");
    writeFileSync(prompt, "Create notes.txt containing exactly: cancelled\n");
    const submit = cli(
      state.config,
      state.data,
      "jobs",
      "submit",
      "--dir",
      folder,
      "--prompt-file",
      prompt,
      "--model-profile-id",
      state.worker,
    );
    expect(submit.status === 0, `submit exit ${submit.status}: ${submit.stderr}`);
    const id = submit.stdout.trim().split(/\s+/).at(-1);
    const cancel = cli(state.config, state.data, "jobs", "cancel", id);
    expect(cancel.status === 0, `cancel exit ${cancel.status}: ${cancel.stderr}`);
    const watch = cli(state.config, state.data, "jobs", "watch", id);
    expect(watch.status === 1, `watch of a cancelled job exited ${watch.status}`);
    const job = await api("GET", `/api/v1/jobs/${id}`, state.token);
    expect(job.value.status === "cancelled", `job is ${job.value.status}`);
  });

  await check(
    "attached work: the orchestrator's Pi worker writes the project folder through Poundlock",
    async () => {
      const run = spawnSync(
        process.execPath,
        [
          join(root, "node_modules/vitest/vitest.mjs"),
          "run",
          "tests/live-dispatch-use-cases.test.ts",
          "-t",
          "U1|U2",
        ],
        {
          cwd: root,
          env: { ...process.env, POUNDLOCK_URL: base, POUNDLOCK_TOKEN: state.token },
          encoding: "utf8",
          timeout: 900_000,
        },
      );
      const summary = run.stdout
        .split("\n")
        .filter((line) => /Tests\s/.test(line))
        .join(" ");
      expect(run.status === 0 && /2 passed/.test(summary), `${summary} ${run.stdout.slice(-1500)}`);
      return summary.trim();
    },
  );
} finally {
  if (results.some((r) => r.result !== "PASS"))
    console.error(compose("logs", "--no-color", "--tail", "120"));
  if (!keep) {
    try {
      compose("down", "-v", "--remove-orphans");
    } catch (error) {
      console.error(String(error));
    }
  }
}
const report = {
  image,
  results,
  passed: results.filter((r) => r.result === "PASS").length,
  failed: results.filter((r) => r.result !== "PASS").length,
};
if (reportAt >= 0) {
  mkdirSync(dirname(args[reportAt + 1]), { recursive: true });
  writeFileSync(args[reportAt + 1], `${JSON.stringify(report, null, 2)}\n`);
}
console.log(`${report.passed} passed, ${report.failed} failed`);
process.exit(report.failed || !results.length ? 1 : 0);
