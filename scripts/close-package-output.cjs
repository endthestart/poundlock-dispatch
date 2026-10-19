const { execFileSync } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const { resolve, sep } = require("node:path");

if (process.platform !== "darwin") process.exit(0);

const outputs = ["mac-arm64", "mac"].map((name) => resolve(__dirname, "..", "release", name));

function runningOutputProcesses() {
  const lines = execFileSync("/bin/ps", ["-axo", "pid=,comm="], { encoding: "utf8" }).split("\n");
  return lines.flatMap((line) => {
    const match = line.match(/^\s*(\d+)\s+(\/.*)$/);
    if (!match) return [];
    const command = match[2].trim();
    if (!existsSync(command)) return [];
    const executable = realpathSync(command);
    return outputs.some((output) => executable.startsWith(`${output}${sep}`))
      ? [Number(match[1])]
      : [];
  });
}

async function closeOutput() {
  const processes = runningOutputProcesses();
  if (!processes.length) return;
  for (const pid of processes) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!runningOutputProcesses().length) {
      process.stdout.write("Closed the running Dispatch build before replacement.\n");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The running Dispatch build did not close. Packaging was stopped safely.");
}

closeOutput().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
