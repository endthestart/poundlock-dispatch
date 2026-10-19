#!/usr/bin/env python3
"""Print an osv-scanner config that ignores what security/npm-audit-allow.json allows.

usage: npm-allow-to-osv.py ALLOW_JSON > osv-scanner.toml

The npm audit gate and osv-scanner see the same advisories in package-lock.json.
Both read this one file, so an exception is added, reasoned and dated once, and
osv-scanner reports the advisory again the day after `expires`.
"""

import json
import sys


def main(path):
    with open(path, encoding="utf-8") as handle:
        allowed = json.load(handle)
    for advisory, entry in sorted(allowed.items()):
        print("[[IgnoredVulns]]")
        print(f"id = {json.dumps(advisory)}")
        print(f"ignoreUntil = {entry['expires']}")
        print(f"reason = {json.dumps(entry['reason'])}")
        print()


if __name__ == "__main__":
    main(sys.argv[1])
