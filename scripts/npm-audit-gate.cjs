// Fail on any npm advisory unless it is listed, unexpired, in the allow file.
//
// usage: node scripts/npm-audit-gate.cjs AUDIT_JSON ALLOW_JSON
//
// AUDIT_JSON is `npm audit --json` output. ALLOW_JSON maps an advisory id
// (GHSA-...) to {"expires": "YYYY-MM-DD", "reason": "..."}. An exception covers
// a known, accepted exposure while the real fix lands; once it expires the
// build fails again. Mirrors Poundlock's scripts/npm-audit-gate.py.
const { readFileSync } = require("node:fs");

function advisories(audit) {
  const found = new Map();
  for (const vulnerability of Object.values(audit.vulnerabilities ?? {})) {
    for (const via of vulnerability.via ?? []) {
      if (via && typeof via === "object" && via.url) {
        found.set(via.url.replace(/\/+$/, "").split("/").pop(), via.title ?? "");
      }
    }
  }
  return found;
}

function localDate(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Returns the lines to print and the failures; `today` is YYYY-MM-DD.
function gate(audit, allowed, today) {
  if (!audit || typeof audit !== "object" || "error" in audit || !("vulnerabilities" in audit)) {
    const detail = JSON.stringify(audit?.error ?? audit);
    return { allowed: [], failures: [`npm audit did not produce a report: ${detail}`] };
  }
  const allowedLines = [];
  const failures = [];
  for (const [advisory, title] of [...advisories(audit)].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const entry = Object.hasOwn(allowed, advisory) ? allowed[advisory] : undefined;
    if (entry === undefined) {
      failures.push(`npm advisory: ${advisory}: ${title}`);
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(entry?.expires ?? "") || !entry.reason) {
      failures.push(`npm advisory: ${advisory}: exception needs an expires date and a reason`);
    } else if (entry.expires < today) {
      failures.push(`npm advisory: ${advisory}: exception expired ${entry.expires} (${title})`);
    } else {
      allowedLines.push(`allowed until ${entry.expires}: ${advisory} (${entry.reason})`);
    }
  }
  return { allowed: allowedLines, failures };
}

function main(auditPath, allowPath) {
  if (!auditPath || !allowPath) {
    console.error("usage: node scripts/npm-audit-gate.cjs AUDIT_JSON ALLOW_JSON");
    return 2;
  }
  const audit = JSON.parse(readFileSync(auditPath, "utf8"));
  const allowed = JSON.parse(readFileSync(allowPath, "utf8"));
  const result = gate(audit, allowed, localDate());
  for (const line of result.allowed) console.log(line);
  for (const failure of result.failures) console.error(failure);
  return result.failures.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv[2], process.argv[3]);

module.exports = { advisories, gate, localDate, main };
