/**
 * One real project through Dispatch against a live controller, with a real Pi
 * manager and real Pi workers, every role bound to one profile.
 *
 * This is the workstation topology the 2026-09-23 bake-off recommended — Qwen3.8
 * as manager and worker on one runtime slot — run the way the demo will run
 * it: the talk's own `tokenize_rate.py` prompt, plan, approval, worker,
 * review. It records what the owner asked to see measured: wake, the first
 * manager reply, capacity waits, and whether the run finishes cleanly.
 *
 * Skipped unless explicitly enabled; it spends real minutes on real hardware.
 *
 *   POUNDLOCK_LIVE_TOPOLOGY=1 POUNDLOCK_URL=... POUNDLOCK_TOKEN=... \
 *   POUNDLOCK_TOPOLOGY_PROFILE=vega-manager \
 *   POUNDLOCK_TOPOLOGY_REPORT=/path/report.json npx vitest run tests/live-topology.test.ts
 *
 * Everything lives in a temporary directory: it never reads or writes the
 * desktop app's or the terminal client's own data.
 */
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { ApprovalBroker } from "@core/approval-broker";
import { DispatchHost } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { FileStore } from "@core/store";
import { hostCommandPort } from "@runtime/host-command";
import { createManagerProvider } from "@runtime/manager-provider";
import { createPiWorker } from "@runtime/pi-worker";
import type { RoleBinding, RoleMap } from "@shared/roles";
import type { AppStateView } from "@shared/types";
import { describe, expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const url = process.env.POUNDLOCK_URL;
const token = process.env.POUNDLOCK_TOKEN;
const profileName = process.env.POUNDLOCK_TOPOLOGY_PROFILE ?? "vega-manager";
const report = process.env.POUNDLOCK_TOPOLOGY_REPORT;
const run = url && token && process.env.POUNDLOCK_LIVE_TOPOLOGY === "1" ? it : it.skip;

/** The talk's live prompt, unchanged (presentations/hour-talk/DEMO-PROMPT.md). */
const PROMPT = `Write a Python 3 script named \`tokenize_rate.py\` that prints prompt-processing
speed and token-generation speed.

Usage:

\`python3 tokenize_rate.py PROMPT_TOKENS GEN_TOKENS PREFILL_SECONDS DECODE_SECONDS\`

Print exactly two lines:

\`pp: <rate> tok/s\`
\`tg: <rate> tok/s\`

Rates are prompt tokens / prefill seconds and generated tokens / decode
seconds, with two decimal places. If a duration is 0, print \`n/a\` instead of
a rate for that line. Do not use the network. After writing the file, run
\`python3 tokenize_rate.py 1024 128 2.0 10.0\` and confirm the output is
\`pp: 512.00 tok/s\` then \`tg: 12.80 tok/s\`.`;

const SETTLED = ["completed", "failed", "cancelled", "needs_input", "paused"];

describe("live topology: one profile in every role", () => {
  run(
    "plans, implements and reviews the demo task on one runtime slot",
    async () => {
      const root = await tempDir("dispatch-topology-");
      const folder = join(root, "project");
      await mkdir(folder);
      const store = new FileStore(join(root, "data"), join(root, "config"));
      await store.init();
      const approvals = new ApprovalBroker(() => {
        void host.emitState();
      });
      const host: DispatchHost = new DispatchHost(
        { dataRoot: join(root, "data") },
        store,
        approvals,
        {
          worker: () => createPiWorker(),
          managerProvider: (wiring) =>
            createManagerProvider(
              wiring.getStore,
              wiring.approvals,
              async (text, projectId) => wiring.recordActivity(text, projectId),
              wiring.onSelection,
              wiring.capabilities,
            ),
          orchestrator: (deps) =>
            new ProjectOrchestrator({ ...deps, hostCommands: hostCommandPort }),
          lifecycle: (deps) => new ProjectLifecycle(deps),
        },
      );

      const started = Date.now();
      const at = () => Math.round((Date.now() - started) / 1000);
      const timeline: Array<{ t: number; event: string }> = [];
      const note = (event: string) => {
        timeline.push({ t: at(), event });
      };

      await host.saveConnection({ url: url!, token: token!, roles: {} });
      await host.refreshServerInfo();
      const probe = (await host.getState()).probe;
      expect(probe?.ok, probe?.error).toBe(true);
      const interactive = probe!.interactiveModels.find((model) => model.id === profileName);
      expect(interactive, `${profileName} is not served interactively`).toBeDefined();
      const bind = (model: {
        id: string;
        name?: string;
        profileId?: string;
        routingRevision?: string;
      }): RoleBinding => ({
        profileId: model.profileId ?? model.id,
        profileName: model.name ?? model.id,
        source: "interactive",
        routingRevision: model.routingRevision,
        lastApprovedRoutingRevision: model.routingRevision,
      });
      const roles: RoleMap = {
        manager: bind(interactive!),
        interactive: bind(interactive!),
      };
      await host.saveModels(roles);

      await host.createProjectFromFolder({ folder, name: "topology" });
      const projectId = (await host.getState()).selectedProjectId!;
      // What a client does once at launch, before any work: recover the last
      // session and start polling. Calling it after approval instead treats
      // the running worker as left over from a closed app and pauses it.
      await host.start();

      // What a watching user would see, and would click.
      let lastStatus = "";
      let draftSeen = false;
      let capacityNotices = 0;
      const answered = new Set<string>();
      const stop = host.onState((state: AppStateView) => {
        const status = state.snapshot?.project.status ?? "";
        if (status !== lastStatus) {
          note(`status ${status}`);
          lastStatus = status;
        }
        if (state.managerDraft && !draftSeen) {
          draftSeen = true;
          note("first manager text streamed");
        }
        if (state.activity && /capacity|busy/i.test(state.activity)) capacityNotices += 1;
        for (const approval of state.approvals ?? []) {
          if (approval.projectId !== projectId || answered.has(approval.id)) continue;
          answered.add(approval.id);
          note(`approved once: ${approval.action}`);
          void host.decideApproval(approval.id, "once");
        }
      });

      note("message sent");
      await host.sendMessage(PROMPT, { projectId });
      note("manager turn returned");
      const planned = (await host.getState()).snapshot!;
      expect(planned.project.status, "the manager should plan, not ask").toBe("awaiting_approval");
      await host.approvePlan({ projectId });
      note("plan approved");

      const deadline = Date.now() + 50 * 60_000;
      let final: AppStateView | undefined;
      while (Date.now() < deadline) {
        final = await host.getState();
        const status = final.snapshot?.project.status ?? "";
        if (SETTLED.includes(status)) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      stop();
      const tasks = final?.snapshot?.tasks ?? [];
      const attempts = tasks.flatMap((task) =>
        task.attempts.map((attempt) => ({
          task: task.title,
          profile: attempt.profileName,
          status: attempt.status,
          failureClass: attempt.failureClass,
          error: attempt.error,
        })),
      );

      let output = "";
      try {
        output = (
          await promisify(execFile)("python3", ["tokenize_rate.py", "1024", "128", "2.0", "10.0"], {
            cwd: folder,
          })
        ).stdout;
      } catch (error) {
        output = `could not run: ${error instanceof Error ? error.message : String(error)}`;
      }
      const result = {
        profile: profileName,
        finalStatus: final?.snapshot?.project.status,
        seconds: at(),
        timeline,
        capacityNotices,
        approvals: answered.size,
        tasks: tasks.map((task) => ({ title: task.title, status: task.status })),
        attempts,
        output,
        messages: (final?.snapshot?.messages ?? []).map((message) => ({
          role: message.role,
          text: message.text.slice(0, 400),
        })),
      };
      if (report) await writeFile(report, JSON.stringify(result, null, 2));
      await host.shutdown();

      expect(final?.snapshot?.project.status).toBe("completed");
      expect(output.trim()).toBe("pp: 512.00 tok/s\ntg: 12.80 tok/s");
      // Every attempt ran on the one profile: nothing swapped the slot's model.
      expect(new Set(attempts.map((attempt) => attempt.profile))).toEqual(new Set([profileName]));
    },
    60 * 60_000,
  );
});
