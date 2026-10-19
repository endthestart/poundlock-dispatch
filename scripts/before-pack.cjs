const { execFileSync } = require("node:child_process");
const { existsSync, realpathSync } = require("node:fs");
const { resolve, dirname, basename, sep } = require("node:path");

function canonical(path) {
  const full = resolve(path);
  return existsSync(full) ? realpathSync(full) : resolve(canonical(dirname(full)), basename(full));
}

function assertOutputClosed(output, commands) {
  const root = canonical(output) + sep;
  if (commands.split("\n").some(command => command.trim().startsWith("/") && canonical(command.trim()).startsWith(root))) {
    throw new Error(`Quit the app in ${output} before packaging. Rebuilding an open app can invalidate its cached resources.`);
  }
}

module.exports = async function beforePack(context) {
  if (process.platform !== "darwin") return;
  // Electron caches ASAR offsets. Replacing a running bundle can make an HTML
  // request read unrelated bytes (such as CSS) from the new archive.
  const commands = execFileSync("/bin/ps", ["-axo", "comm="], { encoding: "utf8" });
  assertOutputClosed(context.appOutDir, commands);
};
module.exports.assertOutputClosed = assertOutputClosed;
