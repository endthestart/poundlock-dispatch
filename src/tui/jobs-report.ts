/** What the `jobs` commands print about a connection and a finished job. */

import { type PoundlockJob, parseJobResult } from "@core/poundlock";
import { verificationFailed } from "@core/workflow-support";
import { destinationLabel } from "@shared/roles";
import { type ConnectionProbe, JOB_PERMISSIONS, permissionLabel } from "@shared/types";

type Say = (text: string) => void;

export function probe(result: ConnectionProbe, say: Say, warn: Say): number {
  say(`url: ${result.url}`);
  say(`ready: ${result.ready ? "yes" : "no"}`);
  if (result.version) say(`version: ${result.version}`);
  const label = (name: string) => permissionLabel(name, result.capabilities);
  if (result.permissions.length) say(`permissions: ${result.permissions.map(label).join(", ")}`);
  const missingJobs = JOB_PERMISSIONS.filter((name) => !result.permissions.includes(name));
  if (missingJobs.length) say(`missing for jobs: ${missingJobs.map(label).join(", ")}`);
  if (result.missingPermissions.length) {
    say(`missing for the app: ${result.missingPermissions.map(label).join(", ")}`);
    say("These are not needed for the jobs commands; the Dispatch app uses them.");
  }
  say(`outbound network for jobs: ${result.outboundNetworkAllowed ? "allowed" : "not allowed"}`);
  if (result.durableModels.length) {
    say("job model profiles:");
    for (const model of result.durableModels)
      say(
        `  ${model.name} (${model.id})${model.data_destination ? `, ${destinationLabel(model.data_destination)}` : ""}${model.busy ? ", busy" : ""}`,
      );
  }
  if (result.harnesses.length) {
    say("harnesses:");
    for (const harness of result.harnesses)
      say(`  ${harness.name} (${harness.id}) ${harness.version}`);
  }
  const usable = result.ready && missingJobs.length === 0;
  if (!usable) {
    warn(result.error ?? "This token cannot run jobs.");
    if (result.hint) warn(result.hint);
  }
  return usable ? 0 : 1;
}

/** The wall-clock budget a running job has left, once a runner has claimed it. */
export function wallTimeLeft(deadlineAt: string | null | undefined, now: Date): string {
  if (typeof deadlineAt !== "string" || !deadlineAt) return "not yet claimed by a runner";
  const remaining = new Date(deadlineAt).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return "unknown";
  if (remaining <= 0) return "deadline passed";
  const minutes = Math.ceil(remaining / 60_000);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
}

/**
 * The job's output as a person reads it. Pi's harness output is its JSON event
 * stream; from that only the agent's last reply is shown, since the events are
 * already printed as they happen. Anything else is shown as it is.
 */
function readableOutput(output: string): string {
  const text = output.trim();
  if (!text.startsWith("{")) return text;
  let reply: string | undefined;
  for (const line of text.split("\n")) {
    let event: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    const content = event.message.content;
    const said = Array.isArray(content)
      ? content
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text as string)
          .join("")
          .trim()
      : "";
    if (said) reply = said;
  }
  return reply ?? text;
}

export function report(job: PoundlockJob, say: Say, now: Date): number {
  const result = parseJobResult(job);
  say(`job: ${job.id}`);
  say(`status: ${job.status}`);
  say(`attempt: ${job.attempt_id}`);
  say(`model profile: ${job.model_profile_id}`);
  say(`harness profile: ${job.harness_profile_id}`);
  if (typeof job.wall_seconds === "number") say(`wall seconds: ${job.wall_seconds}`);
  if (job.deadline_at) say(`wall time: ${wallTimeLeft(job.deadline_at, now)}`);
  if (job.error)
    say(`error: ${typeof job.error === "string" ? job.error : JSON.stringify(job.error)}`);
  if (result.verification) {
    say(
      `checks: ${result.verification.status}${result.verification.reason ? `, ${result.verification.reason}` : ""}`,
    );
    for (const check of result.verification.commands)
      say(`  ${check.exitCode === 0 ? "passed" : "failed"}: ${check.command}`);
    if (result.verification.changedProtectedPaths?.length)
      say(`changed protected paths: ${result.verification.changedProtectedPaths.join(", ")}`);
  }
  say(`patches: ${result.patches.length}`);
  result.patches.forEach((patch, index) => {
    say(
      `  ${index}: ${patch.root || "."} ${Buffer.byteLength(patch.patch)} bytes sha256 ${patch.sha256}`,
    );
  });
  const output = readableOutput(result.output);
  if (output) say(`\noutput:\n${output}`);
  return job.status === "completed" && !verificationFailed(result.verification) ? 0 : 1;
}

/** `1 file`, `4 files`. */
export function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
