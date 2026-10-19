// Third-party notices for what Dispatch actually distributes.
//
//   node scripts/license-inventory.cjs [--texts FILE]
//
// Walks the installed production dependency tree (npm ls --omit=dev), so
// platform-specific packages are the ones this machine would ship. Writes the
// summary table THIRD_PARTY_NOTICES.md and, with --texts, every package's full
// license text plus the fonts and theme bundled in the app. Fails on a package
// with no license declaration or no license text. Packages whose npm archive
// omits the text use a copy recorded in licenses/sources.json with its upstream
// source and SHA-256.
const { execFileSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");

const root = join(__dirname, "..");
const sources = JSON.parse(readFileSync(join(root, "licenses/sources.json"), "utf8"));
const EMBEDDED = [
  ["Inter font", "OFL-1.1", "src/renderer/fonts/INTER-LICENSE"],
  ["JetBrains Mono font", "OFL-1.1", "src/renderer/fonts/JETBRAINS-MONO-LICENSE"],
  ["Catppuccin palette (app colours)", "MIT", "licenses/catppuccin-LICENSE"],
];

function override(name, version) {
  return sources.find(
    (row) =>
      row.version === version &&
      (row.package === name || (row.package.endsWith("/*") && name.startsWith(row.package.slice(0, -1)))),
  );
}

function licenseFiles(path, name, version) {
  const files = readdirSync(path, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^(licen[cs]e|copying|notice|unlicense)/i.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((file) => ({ name: file, text: readFileSync(join(path, file), "utf8") }));
  if (files.length) return { files };
  const row = override(name, version);
  if (!row) return { files };
  const bytes = readFileSync(join(root, "licenses", row.file));
  if (createHash("sha256").update(bytes).digest("hex") !== row.sha256)
    throw new Error(`License text hash mismatch: licenses/${row.file}`);
  return { files: [{ name: row.file, text: bytes.toString("utf8") }], upstream: row.upstream };
}

const paths = execFileSync("npm", ["ls", "--omit=dev", "--all", "--parseable"], {
  cwd: root,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .slice(1);
const seen = new Map();
for (const path of paths) {
  const info = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  const license = typeof info.license === "string" ? info.license : (info.license?.type ?? "UNKNOWN");
  const key = `${info.name}@${info.version}`;
  if (!seen.has(key)) seen.set(key, { name: info.name, version: info.version, license, path });
}
const rows = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
const undeclared = rows.filter((row) => row.license === "UNKNOWN" || row.license === "UNLICENSED");
if (undeclared.length)
  throw new Error(`No distributable license declaration: ${undeclared.map((r) => r.name).join(", ")}`);

writeFileSync(
  join(root, "THIRD_PARTY_NOTICES.md"),
  "# Third-party dependencies\n\n" +
    "Generated from the production dependency installation. Each package keeps its own license. " +
    "The app and the terminal client carry the full texts in THIRD_PARTY_LICENSES.md, together with " +
    "the bundled fonts (SIL Open Font License 1.1), the Catppuccin-derived colours (MIT) and, in the app, " +
    "Electron's own LICENSE and LICENSES.chromium.html.\n\n" +
    "| Package | Version | License |\n|---|---|---|\n" +
    rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} |`).join("\n") +
    "\n",
);

const textsAt = process.argv.indexOf("--texts");
if (textsAt > 0) {
  const blocks = [
    "# Third-party licenses",
    "",
    `Generated for ${process.platform}-${process.arch} from the installed production dependencies.`,
    "",
  ];
  const missing = [];
  for (const row of rows) {
    const { files, upstream } = licenseFiles(row.path, row.name, row.version);
    if (!files.length) {
      missing.push(`${row.name}@${row.version}`);
      continue;
    }
    blocks.push(`## ${row.name} ${row.version}`, "", `License: ${row.license}`, "");
    if (upstream) blocks.push(`Upstream: ${upstream}`, "");
    for (const file of files) blocks.push(`### ${file.name}`, "", file.text.trimEnd(), "");
  }
  if (missing.length) throw new Error(`Missing license text: ${missing.join(", ")}`);
  blocks.push("# Fonts and theme bundled with the app", "");
  for (const [name, license, path] of EMBEDDED)
    blocks.push(`## ${name}`, "", `License: ${license}`, "", readFileSync(join(root, path), "utf8").trimEnd(), "");
  mkdirSync(dirname(process.argv[textsAt + 1]), { recursive: true });
  writeFileSync(process.argv[textsAt + 1], blocks.join("\n"));
}
console.log(`Inventoried ${rows.length} production dependency licenses`);
