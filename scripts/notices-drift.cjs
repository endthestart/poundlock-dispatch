// Fails when THIRD_PARTY_NOTICES.md no longer lists the production dependencies.
// Platform packages (an esbuild or rollup binary) are left out: their rows depend
// on the machine that generated the file, not on the lockfile.
//   node scripts/notices-drift.cjs COMMITTED.md GENERATED.md
const { readFileSync } = require("node:fs");

const PLATFORM = /(?:^|[-/])(?:darwin|linux|win32|android|freebsd|openbsd|netbsd|sunos|aix)(?:-|$)/;

function rows(path) {
  return new Set(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("| ") && !line.startsWith("| Package |"))
      .filter((line) => !PLATFORM.test(line.split("|")[1].trim())),
  );
}

const [committed, generated] = process.argv.slice(2, 4).map(rows);
const missing = [...generated].filter((row) => !committed.has(row));
const stale = [...committed].filter((row) => !generated.has(row));
if (missing.length || stale.length) {
  console.error("THIRD_PARTY_NOTICES.md is out of date; run node scripts/license-inventory.cjs.");
  for (const row of missing) console.error(`  missing: ${row}`);
  for (const row of stale) console.error(`  stale:   ${row}`);
  process.exit(1);
}
console.log("THIRD_PARTY_NOTICES.md matches the production dependencies.");
