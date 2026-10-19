import type { ToolApproval } from "./permissions.js";

export function approvalHeadline(kind: string): string {
  switch (kind) {
    case "bash":
      return "Run this command";
    case "write":
      return "Write this file";
    case "read":
      return "Read this file";
    case "inference":
      return "Use this model";
    case "offbox":
      return "Send work off this Mac";
    default:
      return "Approve this action";
  }
}

export function shellJoin(program: string, args: readonly string[]): string {
  return [program, ...args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function approvalPrimary(request: ToolApproval): string {
  return request.displayCommand ?? request.action;
}

export function rememberLabel(request: ToolApproval): string {
  if (request.kind === "bash" && request.cwd) {
    return "Remember this exact command in this folder";
  }
  if (request.cwd) return "Remember this exact action in this folder";
  return "Allow this action for this plan";
}

export function approvalIgnoresKeyboardTarget(
  target?: {
    tagName?: string;
    isContentEditable?: boolean;
  } | null,
): boolean {
  if (!target) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName ?? "");
}

export function approvalShortcut(event: {
  key: string;
  shiftKey: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}): "once" | "always" | "deny" | undefined {
  if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return undefined;
  if (event.key === "Escape") return "deny";
  if (event.key === "Enter") return event.shiftKey ? "always" : "once";
  return undefined;
}
