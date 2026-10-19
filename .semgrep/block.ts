// Positive and negative controls for block.yml. A rule that never fires would
// make the gate look clean, so CI runs `semgrep --test` here before the scan.
import { createHash } from "node:crypto";
import { exec, execFile, execSync, spawn } from "node:child_process";
import { shell } from "electron";

declare const command: string;
declare const url: string;
declare const node: HTMLElement;
declare const model: { text: string };
declare const isolation: { exec(command: string): Promise<void> };

export function processes(): void {
  // ruleid: dispatch-ts-child-process-exec
  exec(command);
  // ruleid: dispatch-ts-child-process-exec
  execSync(command);
  // ok: dispatch-ts-child-process-exec
  execFile("git", ["status"]);
  // ok: dispatch-ts-child-process-exec
  void isolation.exec(command);
  // ruleid: dispatch-ts-spawn-shell-true
  spawn(command, [], { shell: true });
  // ok: dispatch-ts-spawn-shell-true
  spawn("git", ["status"], { stdio: "ignore" });
}

export function html(): void {
  // ruleid: dispatch-ts-html-sink
  node.innerHTML = model.text;
  // ruleid: dispatch-ts-html-sink
  node.insertAdjacentHTML("beforeend", model.text);
  // ok: dispatch-ts-html-sink
  node.textContent = model.text;
}

export function electron(): void {
  // ruleid: dispatch-ts-electron-open-external
  void shell.openExternal(url);
  // ok: dispatch-ts-electron-open-external
  void shell.openExternal("https://example.com/docs");
  const good = { contextIsolation: true, nodeIntegration: false };
  // ruleid: dispatch-ts-electron-insecure-web-preferences
  const bad = { contextIsolation: false };
  // ruleid: dispatch-ts-electron-insecure-web-preferences
  const worse = { nodeIntegration: true };
  void [good, bad, worse];
}

export function dynamicCode(text: string): unknown {
  // ruleid: dispatch-ts-eval
  eval(text);
  // ruleid: dispatch-ts-eval
  return new Function(text);
}

export function tls(): void {
  // ruleid: dispatch-ts-tls-verification-off
  const agent = { rejectUnauthorized: false };
  // ok: dispatch-ts-tls-verification-off
  const strict = { rejectUnauthorized: true };
  void [agent, strict];
}

export function hashes(data: string): void {
  // ruleid: dispatch-ts-weak-hash
  createHash("md5").update(data);
  // ok: dispatch-ts-weak-hash
  createHash("sha256").update(data);
}

// ruleid: dispatch-ts-plain-http-literal
export const REMOTE = "http://controller.example:7331";
// ok: dispatch-ts-plain-http-literal
export const LOOPBACK = "http://127.0.0.1:7331";
// ok: dispatch-ts-plain-http-literal
export const SECURE = "https://controller.example";
