import {
  approvalHeadline,
  approvalIgnoresKeyboardTarget,
  approvalPrimary,
  approvalShortcut,
  rememberLabel,
  shellJoin,
} from "@shared/approval-copy";
import type { ToolApproval } from "@shared/permissions";
import { expect, it } from "vitest";

function request(partial: Partial<ToolApproval>): ToolApproval {
  return {
    id: "1",
    projectId: "p",
    projectName: "Demo",
    planRevision: 1,
    kind: "bash",
    action: "raw",
    reason: "Ask",
    ...partial,
  };
}

it("uses English headlines instead of kind tokens", () => {
  expect(approvalHeadline("bash")).toBe("Run this command");
  expect(approvalHeadline("write")).toBe("Write this file");
});

it("shows the rewritten command as primary and names the folder for Remember", () => {
  const card = request({
    cwd: "/tmp/app",
    displayCommand: "uv run python -c 'print(1)'",
    requestedCommand: "python -c 'print(1)'",
  });
  expect(approvalPrimary(card)).toBe("uv run python -c 'print(1)'");
  expect(rememberLabel(card)).toBe("Remember this exact command in this folder");
  expect(shellJoin("uv", ["run", "python", "-c", "print(1)"])).toBe("uv run python -c 'print(1)'");
});

it("maps Enter to Allow once even when a composer would also handle the key", () => {
  expect(approvalShortcut({ key: "Enter", shiftKey: false })).toBe("once");
  expect(approvalShortcut({ key: "Enter", shiftKey: true })).toBe("always");
  expect(approvalShortcut({ key: "Escape", shiftKey: false })).toBe("deny");
  expect(approvalShortcut({ key: "Enter", shiftKey: false, metaKey: true })).toBeUndefined();
  expect(approvalShortcut({ key: "Enter", shiftKey: false, isComposing: true })).toBeUndefined();
});

it("does not treat Enter in the composer as Allow once", () => {
  expect(approvalIgnoresKeyboardTarget({ tagName: "TEXTAREA" })).toBe(true);
  expect(approvalIgnoresKeyboardTarget({ tagName: "INPUT" })).toBe(true);
  expect(approvalIgnoresKeyboardTarget({ tagName: "DIV" })).toBe(false);
});
