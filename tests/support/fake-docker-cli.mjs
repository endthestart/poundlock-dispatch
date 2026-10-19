#!/usr/bin/env node
/**
 * A stand-in for the Docker CLI in offline tests. Containers are JSON files in
 * FAKE_DOCKER_STATE, and every call is logged there (calls.jsonl). `run --rm`
 * and `exec` run their command on this machine, in the requested working
 * directory, each in its own process group so `kill -9 -1` can be honoured.
 * It tests how Dispatch drives a container, not the container's isolation.
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const state = process.env.FAKE_DOCKER_STATE;
if (!state) {
  process.stderr.write("FAKE_DOCKER_STATE is not set\n");
  process.exit(125);
}
mkdirSync(join(state, "containers"), { recursive: true });
mkdirSync(join(state, "pids"), { recursive: true });
let args = process.argv.slice(2);
appendFileSync(join(state, "calls.jsonl"), `${JSON.stringify(args)}\n`);
if (args[0] === "--context") args = args.slice(2);
// A `down` file in the state folder stands for a stopped VM: the client cannot reach the daemon.
if (existsSync(join(state, "down"))) {
  process.stderr.write(
    "Cannot connect to the Docker daemon at unix:///fake/docker.sock. Is the docker daemon running?\n",
  );
  process.exit(1);
}
const [command, ...rest] = args;
const images = (process.env.FAKE_DOCKER_IMAGES ?? "").split(",").filter(Boolean);
/** Each image's ID; an image is known by its name or its ID. */
const idOf = (name) => `sha256:fake-${name.replace(/[^A-Za-z0-9]/g, "-")}`;
const known = (image) => images.includes(image) || images.map(idOf).includes(image);
const containerFile = (name) => join(state, "containers", `${name}.json`);
const container = (name) =>
  existsSync(containerFile(name)) ? JSON.parse(readFileSync(containerFile(name), "utf8")) : null;
const save = (value) => writeFileSync(containerFile(value.name), JSON.stringify(value));

const WITH_VALUE = new Set([
  "--entrypoint",
  "--name",
  "--label",
  "--network",
  "--cap-drop",
  "--security-opt",
  "--pids-limit",
  "--ulimit",
  "--memory",
  "--memory-swap",
  "--cpus",
  "--user",
  "--format",
  "-e",
  "-v",
  "-w",
  "--mount",
]);

/** Docker-style flags up to the first positional argument. */
function flags(list) {
  const values = {};
  const multi = {};
  let i = 0;
  for (; i < list.length && list[i].startsWith("-"); i++) {
    const flag = list[i];
    if (WITH_VALUE.has(flag)) {
      const value = list[++i];
      values[flag] = value;
      multi[flag] = [...(multi[flag] ?? []), value];
    } else values[flag] = true;
  }
  return { values, multi, rest: list.slice(i) };
}

function runLocal(argv, cwd, owner) {
  const child = spawn(argv[0], argv.slice(1), { cwd, stdio: "inherit", detached: true });
  // Kept after the leader exits: a background job it left is still in the group.
  if (child.pid) writeFileSync(join(state, "pids", `${owner}-${child.pid}`), "");
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 137 : 1)));
  child.on("error", (error) => {
    process.stderr.write(`${error.message}\n`);
    process.exit(127);
  });
}

function killAll(name) {
  for (const file of readdirSync(join(state, "pids")).filter((f) => f.startsWith(`${name}-`))) {
    try {
      process.kill(-Number(file.slice(name.length + 1)), "SIGKILL");
    } catch {
      // Already gone.
    }
    rmSync(join(state, "pids", file), { force: true });
  }
}

switch (command) {
  case "version":
    process.stdout.write("29.0.0-fake\n");
    process.exit(0);
    break;
  case "info":
    // An 8 GiB VM.
    process.stdout.write("8589934592\n");
    process.exit(0);
    break;
  case "image": {
    const image = rest.at(-1);
    if (known(image)) {
      process.stdout.write(`${images.includes(image) ? idOf(image) : image}\n`);
      process.exit(0);
    }
    process.stderr.write(`Error: No such image: ${image}\n`);
    process.exit(1);
    break;
  }
  case "inspect": {
    const found = container(rest.at(-1));
    if (!found) {
      process.stderr.write(`Error: No such object: ${rest.at(-1)}\n`);
      process.exit(1);
    }
    const format = flags(rest).values["--format"] ?? "";
    // The spec label, as `{{index .Config.Labels "<key>"}}` would print it.
    const label = /index \.Config\.Labels "([^"]+)"/.exec(format)?.[1];
    const labels = Object.fromEntries(
      (found.labels ?? []).map((entry) => [
        entry.split("=")[0],
        entry.split("=").slice(1).join("="),
      ]),
    );
    process.stdout.write(
      label ? `${found.running} ${label}=${labels[label] ?? "<no value>"}\n` : `${found.running}\n`,
    );
    process.exit(0);
    break;
  }
  case "run": {
    const parsed = flags(rest);
    const [image, ...args] = parsed.rest;
    const argv = parsed.values["--entrypoint"] ? [parsed.values["--entrypoint"], ...args] : args;
    if (!known(image)) {
      process.stderr.write(`Unable to find image '${image}' locally\n`);
      process.exit(125);
    }
    // A bind source the VM does not have is refused, as Docker refuses it.
    for (const mount of parsed.multi["--mount"] ?? []) {
      const source = mount
        .split(",")
        .find((field) => field.startsWith("source="))
        ?.slice("source=".length);
      if (source && !existsSync(source)) {
        process.stderr.write(
          `docker: Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${source}\n`,
        );
        process.exit(125);
      }
    }
    if (parsed.values["-d"]) {
      const name = parsed.values["--name"];
      save({
        name,
        image,
        running: true,
        network: parsed.values["--network"],
        mounts: parsed.multi["-v"] ?? [],
        labels: parsed.multi["--label"] ?? [],
        user: parsed.values["--user"],
      });
      process.stdout.write(`fake-${name}\n`);
      process.exit(0);
    }
    runLocal(argv, parsed.values["-w"] ?? process.cwd(), parsed.values["--name"] ?? "anonymous");
    break;
  }
  case "start": {
    const found = container(rest.at(-1));
    if (!found) process.exit(1);
    save({ ...found, running: true });
    process.exit(0);
    break;
  }
  case "exec": {
    const parsed = flags(rest);
    const [name, ...argv] = parsed.rest;
    if (!container(name)?.running) {
      process.stderr.write(`Error response from daemon: container ${name} is not running\n`);
      process.exit(1);
    }
    if (argv[0] === "sh" && argv[1] === "-c" && argv[2]?.startsWith("kill -9 -1")) {
      killAll(name);
      process.exit(0);
    }
    // The container's /tmp is its own; here that would be this machine's, so it is only logged.
    if (argv[2]?.startsWith("find /tmp -mindepth 1 -delete")) process.exit(0);
    runLocal(argv, parsed.values["-w"] ?? process.cwd(), name);
    break;
  }
  case "rm": {
    const name = rest.at(-1);
    killAll(name);
    rmSync(containerFile(name), { force: true });
    process.exit(0);
    break;
  }
  default:
    process.stderr.write(`fake docker: unknown command ${command}\n`);
    process.exit(125);
}
