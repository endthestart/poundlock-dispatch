// Positive and negative controls for report.yml.
import { spawn } from "node:child_process";

declare const command: string;

export function shellDashC(): string[] {
  // ruleid: dispatch-ts-shell-dash-c
  spawn("bash", ["-c", command]);
  // ruleid: dispatch-ts-shell-dash-c
  const inContainer = ["exec", "name", "sh", "-c", command];
  // ok: dispatch-ts-shell-dash-c
  return [...inContainer, "-C", command];
}

export function environment(): void {
  // ruleid: dispatch-ts-process-env-passthrough
  spawn("node", ["child.js"], { env: process.env });
  // ok: dispatch-ts-process-env-passthrough
  spawn("node", ["child.js"], { env: { PATH: process.env.PATH } });
}
