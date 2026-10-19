import { autoApprovalNotice, planApprovalLabel } from "@shared/permissions";
import type { ChatMessage } from "@shared/types";
import { createColours } from "@tui/colour";
import { ensureHighlightTheme, markdownTheme } from "@tui/markdown-theme";
import { TranscriptView } from "@tui/transcript";
import { describe, expect, it } from "vitest";
import {
  countingManager,
  engineFor,
  planTask,
  recordingWorker,
  workflowFixture,
} from "./support/workflow-fixture";

const delegated = {
  title: "Fix the tokenizer",
  objective: "Fix the tokenizer",
  workerPrompt: "Fix it",
  acceptanceCriteria: "Tests pass",
  difficulty: "small" as const,
};

async function delegateUnder(mode: "ask" | "assist" | "full") {
  const f = await workflowFixture({ prefix: "auto-approval-" });
  await f.store.savePermissions({ defaultMode: mode });
  const { manager } = countingManager(f.store, { tasks: [planTask("Unused")] });
  const engine = engineFor(f, manager, recordingWorker().worker);
  const result = await engine.toolHost(f.project.id).delegateTask(delegated);
  return {
    f,
    engine,
    result,
    messages: await f.store.getMessages(f.project.id),
    plan: await f.store.getPlan(f.project.id),
    project: await f.store.getProject(f.project.id),
  };
}

describe("a plan Dispatch approves without an Approve click", () => {
  it("says so in the conversation under Full access", async () => {
    const { messages, plan, project } = await delegateUnder("full");
    expect(project?.status).toBe("running");
    expect(plan?.approved).toBe(true);
    const notice = messages.filter((message) => message.kind === "notice");
    expect(notice).toHaveLength(1);
    expect(notice[0].role).toBe("system");
    expect(notice[0].text).toBe(
      "Full access: “Fix the tokenizer” started without an Approve click, because it is within the listed permissions and run limits. You can pause or cancel it.",
    );
    // Not the generic receipt that carried no hint an approval was skipped.
    expect(messages.map((message) => message.text).join("\n")).not.toContain(
      "Plan approved within the listed permissions and run limits.",
    );
  });

  it("marks the plan as approved automatically, for the plan view", async () => {
    const { plan } = await delegateUnder("full");
    expect(plan?.autoApprovedUnder).toBe("full");
    expect(planApprovalLabel(plan!)).toBe("Approved automatically (Full access)");
  });

  it("does the same under Approve for me, and names that mode", async () => {
    const { messages, plan } = await delegateUnder("assist");
    expect(messages.find((message) => message.kind === "notice")?.text).toMatch(
      /^Approve for me: .*without an Approve click/,
    );
    expect(planApprovalLabel(plan!)).toBe("Approved automatically (Approve for me)");
  });

  it("stays silent when nothing was skipped: Ask waits for the click", async () => {
    const { result, messages, plan, project } = await delegateUnder("ask");
    expect(result).toContain("awaits approval");
    expect(plan?.approved).toBe(false);
    expect(plan?.autoApprovedUnder).toBeUndefined();
    expect(project?.status).toBe("awaiting_approval");
    expect(messages.some((message) => message.kind === "notice")).toBe(false);
  });

  it("does not call a click the user made automatic", async () => {
    const { f, engine } = await delegateUnder("ask");
    await engine.approvePlan(f.project.id);
    const messages = await f.store.getMessages(f.project.id);
    expect(messages.some((message) => message.kind === "notice")).toBe(false);
    expect(messages.at(-1)?.text).toContain("Plan approved within the listed permissions");
    const plan = await f.store.getPlan(f.project.id);
    expect(plan?.autoApprovedUnder).toBeUndefined();
    expect(planApprovalLabel(plan!)).toBe("Approved");
  });

  it("leaves Autopilot to say how its run continues", async () => {
    const { f, engine } = await delegateUnder("ask");
    const before = (await f.store.getMessages(f.project.id)).length;
    await engine.approvePlan(f.project.id, undefined, true);
    expect((await f.store.getMessages(f.project.id)).length).toBe(before);
    expect((await f.store.getPlan(f.project.id))?.approved).toBe(true);
  });

  it("labels the plan the way it was approved", () => {
    expect(planApprovalLabel({ approved: false })).toBe("Not yet approved");
    expect(planApprovalLabel({ approved: true })).toBe("Approved");
    expect(autoApprovalNotice({ mode: "full", taskTitle: "X" })).toContain("“X”");
  });
});

describe("the notice in the terminal client", () => {
  const colours = createColours({ theme: "mocha", isTTY: true, env: { COLORTERM: "truecolor" } });
  ensureHighlightTheme(colours);
  const transcript = () => new TranscriptView(markdownTheme(colours), colours);
  const receipt: ChatMessage = { id: "r", role: "system", text: "Plan approved.", createdAt: "" };
  const notice: ChatMessage = {
    id: "n",
    role: "system",
    text: autoApprovalNotice({ mode: "full", taskTitle: "Fix it" }),
    createdAt: "",
    kind: "notice",
  };

  /** The ANSI prefix `paint` puts before a role's text. */
  const codeOf = (role: "faint" | "review") => colours.paint(role, "x").split("x")[0];
  const plain = (line: string) =>
    line.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");

  it("is not dimmed like a receipt", () => {
    const view = transcript();
    view.sync([receipt, notice], undefined);
    const [receiptLine, , noticeLine] = view.render(80);
    expect(codeOf("review")).not.toBe(codeOf("faint"));
    expect(receiptLine.startsWith(codeOf("faint"))).toBe(true);
    expect(noticeLine.startsWith(codeOf("review"))).toBe(true);
    expect(noticeLine.startsWith(codeOf("faint"))).toBe(false);
  });

  it("carries the whole sentence", () => {
    const view = transcript();
    view.sync([notice], undefined);
    const text = view.render(200).map(plain).join(" ");
    expect(text).toContain("Full access: \u201cFix it\u201d started without an Approve click");
  });
});
