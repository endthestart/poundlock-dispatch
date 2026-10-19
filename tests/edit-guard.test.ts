import { readFile, realpath, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { EDIT_LOOP_LIMIT } from "@runtime/edit-guard";
import { describe, expect, it } from "vitest";
import { workerFileTools } from "./support/edit-guard-harness";
import { tempDir } from "./support/temp-dir";

const ORIGINAL = [
  "import os",
  "",
  "",
  "def load(path):",
  "    with open(path) as handle:",
  "        return handle.read()",
  "",
  "",
  "def greet(name):",
  "    return 'hello ' + name",
  "",
].join("\n");

/** What `ruff format` would make of it: quotes, and a signature it rewraps. */
const FORMATTED = ORIGINAL.replace("'hello ' + name", '"hello " + name');

async function project(content = ORIGINAL) {
  const root = await realpath(await tempDir("dispatch-edit-guard-"));
  const path = join(root, "app.py");
  await writeFile(path, content);
  return { root, path, tools: workerFileTools(root) };
}

describe("edit guard: a file that changed under the model", () => {
  it("says so on a failed edit, with the changed lines to read again", async () => {
    const { path, tools } = await project();
    await tools.read(path);
    await writeFile(path, FORMATTED);
    const result = await tools.edit(path, [
      { oldText: "    return 'hello ' + name", newText: "    return f'hello {name}'" },
    ]);
    expect(result.isError).toBe(true);
    expect(result.text).toContain(
      "app.py changed on disk after you last read or edited it: line 10 is different now, changed by a formatter, a shell command or another tool. Read lines 7-13 again (offset 7, limit 7) before editing there.",
    );
    // And the current text of those lines, so one call can recover.
    expect(result.text).toContain(`    return "hello " + name`);
  });

  it("tells each change once, and notes it after an edit that still applied", async () => {
    const { path, tools } = await project();
    await tools.read(path);
    await writeFile(path, FORMATTED);
    const first = await tools.edit(path, [{ oldText: "'hello '", newText: "'hi '" }]);
    expect(first.text).toContain("changed on disk");
    const second = await tools.edit(path, [{ oldText: "'hello '", newText: "'hi '" }]);
    expect(second.text).not.toContain("changed on disk");

    const other = await project();
    await other.tools.read(other.path);
    await writeFile(other.path, FORMATTED);
    const applied = await other.tools.edit(other.path, [
      { oldText: "import os", newText: "import sys" },
    ]);
    expect(applied.isError).toBe(false);
    expect(applied.text).toMatch(/^Successfully replaced 1 block\(s\) in /);
    expect(applied.text).toContain(
      "Note: app.py had changed on disk after you last read or edited it: line 10 is different now, changed by a formatter, a shell command or another tool. This edit applied; read lines 7-13 again (offset 7, limit 7) before editing there.",
    );
    expect(await readFile(other.path, "utf8")).toBe(FORMATTED.replace("import os", "import sys"));
  });

  it("stays quiet after the model's own edits and writes, and after a touch", async () => {
    const { path, tools } = await project();
    await tools.read(path);
    const edits = [
      await tools.edit(path, [{ oldText: "import os", newText: "import sys" }]),
      await tools.edit(path, [{ oldText: "import sys", newText: "import os" }]),
      await tools.write(path, ORIGINAL),
      await tools.edit(path, [{ oldText: "import os", newText: "import sys" }]),
    ];
    for (const result of edits) expect(result.text).not.toContain("changed on disk");
    // Same bytes, new times: `sed -i` with no match.
    await writeFile(path, await readFile(path));
    const later = new Date(Date.now() + 5_000);
    await utimes(path, later, later);
    const touched = await tools.edit(path, [{ oldText: "import sys", newText: "import os" }]);
    expect(touched.isError).toBe(false);
    expect(touched.text).not.toContain("changed on disk");
  });

  it("does not guess about a file the model never read or wrote", async () => {
    const { path, tools } = await project();
    await writeFile(path, FORMATTED);
    const result = await tools.edit(path, [{ oldText: "'hello '", newText: "'hi '" }]);
    expect(result.text).not.toContain("changed on disk");
    expect(result.text).toContain("Could not find the oldText in app.py.");
  });
});

describe("edit guard: an edit that is already applied", () => {
  it("says already applied instead of not found", async () => {
    const { path, tools } = await project();
    await tools.read(path);
    const edit = { oldText: "    return 'hello ' + name", newText: "    return f'hello {name}'" };
    expect((await tools.edit(path, [edit])).isError).toBe(false);
    const again = await tools.edit(path, [edit]);
    expect(again.isError).toBe(true);
    expect(again.text).toBe(
      "Already applied: the oldText is not in app.py, but the newText is, at line 10. This change is already made, so nothing was changed. Do not send it again; go on to your next step.",
    );
  });

  it("names the applied edit in a multi-edit call", async () => {
    const { path, tools } = await project();
    await tools.edit(path, [{ oldText: "import os", newText: "import sys" }]);
    const result = await tools.edit(path, [
      { oldText: "def load(path):", newText: "def load(path: str) -> str:" },
      { oldText: "import os", newText: "import sys" },
    ]);
    expect(result.text).toBe(
      "Already applied: edits[1].oldText is not in app.py, but its newText is, at line 1. Nothing was changed: send the other edits again without edits[1].",
    );
  });

  it("answers a no-op edit without Pi's special-characters hint", async () => {
    const { path, tools } = await project();
    const result = await tools.edit(path, [{ oldText: "import os", newText: "import os" }]);
    expect(result.text).toBe(
      "No change: the newText is the same as the oldText, so this edit would not change app.py. That text is at line 1. If the file already says what you want, the change is made: go on to your next step. Otherwise put the text you want in newText.",
    );
  });

  it("does not claim a change is made when the new text proves nothing", async () => {
    const { path, tools } = await project();
    // A deletion re-sent: what remains was always there.
    await tools.edit(path, [{ oldText: "import os\n", newText: "" }]);
    const deletion = await tools.edit(path, [{ oldText: "import os\n", newText: "" }]);
    expect(deletion.text).not.toContain("Already applied");
    // The new text exists elsewhere, and the old text is a misquote of other lines.
    const misquote = await tools.edit(path, [
      { oldText: "    with open(path) as fh:", newText: "        return handle.read()" },
    ]);
    expect(misquote.text).not.toContain("Already applied");
    expect(misquote.text).toContain("The closest text is line 4 (78% similar).");
  });

  it("points at a region that already looks like the new text", async () => {
    const { path, tools } = await project();
    await tools.edit(path, [
      { oldText: "    return 'hello ' + name", newText: "    return 'hello, ' + name + '!'" },
    ]);
    // Re-sent from memory, in slightly different words.
    const result = await tools.edit(path, [
      { oldText: "    return 'hello ' + name", newText: "    return 'hello, ' + name + '.'" },
    ]);
    expect(result.text).toContain(
      "The closest text is line 10 (85% similar). Line 10 already looks like your newText (92% similar), so this change may already be made: check before sending it again.",
    );
  });
});

describe("edit guard: the nearest match on a miss", () => {
  it("shows a whitespace-only difference and the exact text to copy", async () => {
    const { path, tools } = await project();
    const result = await tools.edit(path, [
      {
        oldText: "def load(path):\n        with open(path) as handle:",
        newText: "def load(path):\n        with open(path, encoding='utf-8') as handle:",
      },
    ]);
    expect(result.text).toBe(
      [
        "Could not find the oldText in app.py exactly: lines 4-5 match it apart from whitespace or indentation.",
        "First difference, line 5:",
        '  file:    "    with open(path) as handle:"',
        '  oldText: "        with open(path) as handle:"',
        "Lines 2-7 as the file has them now:",
        "```",
        "",
        "",
        "def load(path):",
        "    with open(path) as handle:",
        "        return handle.read()",
        "",
        "```",
        "Nothing was changed. Copy oldText exactly from these lines, indentation included; do not retype it from memory.",
      ].join("\n"),
    );
  });

  it("shows a misquote's closest region and its first differing line", async () => {
    const { path, tools } = await project();
    const result = await tools.edit(path, [
      { oldText: "def greet(person):\n    return 'hello ' + name", newText: "x" },
    ]);
    expect(result.text).toContain(
      'Could not find the oldText in app.py. The closest text is lines 9-10 (81% similar).\nFirst difference, line 9:\n  file:    "def greet(name):"\n  oldText: "def greet(person):"',
    );
  });

  it("says when nothing in the file is similar", async () => {
    const { path, tools } = await project();
    const result = await tools.edit(path, [
      { oldText: "class Widget(Base):\n    pass", newText: "class Widget(Base):\n    size = 1" },
    ]);
    expect(result.text).toBe(
      "Could not find the oldText in app.py, and no part of the file is similar to it: the text may have been replaced, or be in another file. Nothing was changed. Read the part of app.py you mean to change, then quote oldText exactly from that read.",
    );
  });

  it("bounds what it shows", async () => {
    const lines = Array.from({ length: 400 }, (_, i) => `row_${i} = ${"value ".repeat(20)}${i}`);
    const { path, tools } = await project(`${lines.join("\n")}\n`);
    const quoted = lines.slice(100, 300).join("\n").replace("row_150 =", "row_150 :=");
    const result = await tools.edit(path, [{ oldText: quoted, newText: "x" }]);
    expect(result.text).toContain("The closest text is lines 101-300");
    expect(result.text).toContain("(Cut short at line ");
    expect(result.text.length).toBeLessThan(4_000);
  });

  it("leaves Pi's other errors as they are", async () => {
    const { path, tools } = await project();
    const result = await tools.edit(path, [{ oldText: "handle", newText: "file" }]);
    expect(result.text).toMatch(
      /^Found 2 occurrences of the text in .*app\.py\. The text must be unique/,
    );
  });
});

describe("edit guard: an edit loop", () => {
  it("stops after three failed edits in a row until the file is read", async () => {
    const { path, tools } = await project();
    const stale = { oldText: "    return 'hi ' + name", newText: "    return 'hey ' + name" };
    const first = await tools.edit(path, [stale]);
    const second = await tools.edit(path, [stale]);
    expect(first.text + second.text).not.toContain("in a row");
    const third = await tools.edit(path, [stale]);
    expect(third.text).toContain(
      `This is failed edit ${EDIT_LOOP_LIMIT} in a row on app.py. Stop retrying from memory. Read app.py (the lines you need are enough), then change approach: quote a few unique lines exactly from that read, or rewrite the section with write. Edits to app.py are blocked until you read it.`,
    );
    // Blocked: not run, even an edit that would apply.
    const blocked = await tools.edit(path, [{ oldText: "import os", newText: "import sys" }]);
    expect(blocked).toEqual({
      text: "Edit not run: the last 3 edits to app.py failed, and it has not been read since. Read app.py with the read tool first (the lines you need are enough), then quote oldText exactly from that read, or rewrite the section with write.",
      isError: true,
      blocked: true,
    });
    expect(await readFile(path, "utf8")).toBe(ORIGINAL);
    // A read lifts the block; the count stands until an edit succeeds.
    await tools.read(path, { offset: 9, limit: 2 });
    const fourth = await tools.edit(path, [stale]);
    expect(fourth.blocked).toBe(false);
    expect(fourth.text).toContain("This is failed edit 4 in a row on app.py.");
    await tools.read(path);
    expect(
      (await tools.edit(path, [{ oldText: "import os", newText: "import sys" }])).isError,
    ).toBe(false);
    const fresh = await tools.edit(path, [stale]);
    expect(fresh.text).not.toContain("in a row");
    expect(tools.guard?.evidence()).toEqual({
      edits: 6,
      failed: 5,
      stale: 0,
      alreadyApplied: 0,
      noChange: 0,
      nearestMatch: 5,
      blocked: 1,
      loops: [{ path: "app.py", failures: 4, blocked: 1 }],
    });
  });

  it("ends the run of failures when the model rewrites the file", async () => {
    const { path, tools } = await project();
    const stale = { oldText: "missing text", newText: "x" };
    for (let i = 0; i < EDIT_LOOP_LIMIT; i++) await tools.edit(path, [stale]);
    expect((await tools.write(path, ORIGINAL)).isError).toBe(false);
    const next = await tools.edit(path, [stale]);
    expect(next.blocked).toBe(false);
    expect(next.text).not.toContain("in a row");
  });

  it("counts each file on its own, and records nothing without edits", async () => {
    const { root, path, tools } = await project();
    const other = join(root, "other.py");
    await writeFile(other, "x = 1\n");
    expect(tools.guard?.evidence()).toBeUndefined();
    await tools.edit(path, [{ oldText: "missing", newText: "x" }]);
    await tools.edit(other, [{ oldText: "missing", newText: "x" }]);
    await tools.edit(path, [{ oldText: "missing", newText: "x" }]);
    const result = await tools.edit(other, [{ oldText: "missing", newText: "x" }]);
    expect(result.text).not.toContain("in a row");
    expect(tools.guard?.evidence()?.loops).toEqual([]);
  });
});
