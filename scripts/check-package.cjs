// Checks a built app, not the source tree: the Electron runtime inside it is
// the version package-lock.json selects, its hardening fuses are set, and it
// carries every notice it must.
//
//   node scripts/check-package.cjs "release/mac-arm64/Poundlock Dispatch.app"
//   node scripts/check-package.cjs release/linux-unpacked
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const { FuseV1Options, getCurrentFuseWire } = require("@electron/fuses");

const APACHE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";
const app = process.argv[2];
const mac = app.endsWith(".app");
const resources = mac ? join(app, "Contents", "Resources") : join(app, "resources");
// Electron's own notices sit beside the binary on Linux; ours are extraResources.
const electronNotices = mac ? resources : app;
const binary = mac
  ? join(app, "Contents", "MacOS", "Poundlock Dispatch")
  : join(app, "poundlock-dispatch-gui");
const expected = require("electron/package.json").version;
const lock = JSON.parse(readFileSync(join(__dirname, "..", "package-lock.json"), "utf8"));
const problems = [];
const need = (ok, message) => ok || problems.push(message);

need(lock.packages["node_modules/electron"].version === expected, "installed electron differs from package-lock.json");
let runtime;
if (mac) {
  const plist = join(app, "Contents", "Frameworks", "Electron Framework.framework", "Versions", "A", "Resources", "Info.plist");
  runtime = execFileSync("plutil", ["-extract", "CFBundleVersion", "raw", plist], { encoding: "utf8" }).trim();
} else {
  // The Linux build carries no version file; the binary names its runtime in
  // the user agent it sends ("Electron/<version>").
  const found = new Set(readFileSync(binary).toString("latin1").match(/Electron\/\d+\.\d+\.\d+/g) ?? []);
  runtime = found.size === 1 ? [...found][0].slice("Electron/".length) : `unknown (${[...found].join(", ") || "no version string"})`;
}
need(runtime === expected, `the app runs Electron ${runtime}, not ${expected}`);

(async () => {
  const fuses = await getCurrentFuseWire(binary);
  need(fuses[FuseV1Options.RunAsNode] === 48, "RunAsNode fuse is not disabled");
  need(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable] === 48, "NODE_OPTIONS fuse is not disabled");
  need(fuses[FuseV1Options.EnableNodeCliInspectArguments] === 48, "inspector fuse is not disabled");
  const at = (dir, name) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name)) : undefined);
  const file = (name) => at(resources, name);
  const license = file("LICENSE.dispatch.txt");
  need(license && createHash("sha256").update(license).digest("hex") === APACHE_SHA256, "LICENSE.dispatch.txt is not the canonical Apache-2.0 text");
  for (const name of ["NOTICE.dispatch.txt", "THIRD_PARTY_NOTICES.dispatch.md"]) need(file(name), `missing ${name}`);
  for (const name of ["LICENSE.electron.txt", "LICENSES.chromium.html"]) need(at(electronNotices, name), `missing ${name}`);
  const texts = (file("THIRD_PARTY_LICENSES.dispatch.md") ?? "").toString();
  for (const marker of ["## @earendil-works/pi-coding-agent 1.1.0", "Copyright (c) 2025 Mario Zechner", "## Inter font", "## JetBrains Mono font", "SIL OPEN FONT LICENSE", "## Catppuccin palette"])
    need(texts.includes(marker), `THIRD_PARTY_LICENSES.dispatch.md lacks ${JSON.stringify(marker)}`);
  for (const problem of problems) console.error(problem);
  if (problems.length) process.exit(1);
  console.log(`PASS: Electron ${runtime}, fuses set, notices present in ${app}`);
})();
