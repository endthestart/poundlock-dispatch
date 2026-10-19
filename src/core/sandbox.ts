import { resolve, sep } from "node:path";

export function assertProjectPath(root: string, requested: string): string {
  const trimmed = requested.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("\0")) {
    throw new Error("That path is not allowed.");
  }
  const parts = trimmed.split("/");
  if (parts.some((part) => part === ".." || part === ".git")) {
    throw new Error("Paths must stay inside this project and cannot include Git metadata.");
  }
  const full = resolve(root, trimmed);
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error("That path is outside this project.");
  }
  return full;
}
