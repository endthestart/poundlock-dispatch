// Positive and negative controls for report.yml.
import { spawn } from "node:child_process";

declare const command: string;

export function environment(): void {
  // ruleid: dispatch-ts-process-env-passthrough
  spawn("node", ["child.js"], { env: process.env });
  // ok: dispatch-ts-process-env-passthrough
  spawn("node", ["child.js"], { env: { PATH: process.env.PATH } });
}
