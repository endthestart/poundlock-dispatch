/**
 * L25: project instruction files such as AGENTS.md are conventions for a
 * worker, never a source of permissions.
 */
import { PythonUvAdapter } from "@core/python-uv";
import { AUTO_WORKER_SYSTEM_PROMPT } from "@runtime/auto-session";
import { WORKER_SYSTEM_PROMPT } from "@runtime/pi-worker";
import { describe, expect, it } from "vitest";

describe("worker prompts and project instruction files", () => {
  const briefings = [
    { virtualenv: "/p/.venv", uv: "/usr/bin/uv" },
    { virtualenv: "/p/.venv", python: "/p/.venv/bin/python" },
  ].map((selection) => new PythonUvAdapter().briefing(selection as never) ?? "");

  it("limit AGENTS.md to style and conventions, granting nothing", () => {
    for (const prompt of [WORKER_SYSTEM_PROMPT, AUTO_WORKER_SYSTEM_PROMPT, ...briefings]) {
      expect(prompt).toContain("AGENTS.md");
      expect(prompt).toMatch(/style and conventions/);
      expect(prompt).toMatch(/never grant permissions|grant no permissions/);
      expect(prompt).not.toMatch(/follow project-owned (instruction|convention) files/i);
    }
  });
});
