/**
 * The guided `/autopilot start`: the app's "Build with Autopilot" dialog as
 * questions. It offers what the shared preview says the dialog offers, and
 * turns the answers into the same start options.
 */
import type { AutopilotStartPreview } from "@shared/autopilot-start";
import { askStartOptions, type StartQuestions } from "@tui/auto-start";
import { describe, expect, it } from "vitest";

/** Answers in order; each question's title is recorded. */
function scripted(answers: Array<string | undefined>) {
  const asked: string[] = [];
  const next = () => {
    if (!answers.length) throw new Error(`Unexpected question after: ${asked.at(-1)}`);
    return answers.shift();
  };
  const questions: StartQuestions = {
    text: async (title) => {
      asked.push(title);
      return next();
    },
    choose: async (title, items) => {
      asked.push(title);
      const answer = next();
      if (answer !== undefined && !items.some((item) => item.value === answer))
        throw new Error(`${answer} is not offered for: ${title}`);
      return answer;
    },
  };
  return { questions, asked };
}

const PLAIN: AutopilotStartPreview = {
  approve: false,
  defaultHours: 6,
  defaultImage: "python:3.14-slim",
};

describe("the guided Autopilot start", () => {
  it("asks only the plain questions for an approved plan with checks of its own", async () => {
    const { questions, asked } = scripted(["python:3.14-slim", "2", "", "no", "no", "go"]);
    expect(await askStartOptions(PLAIN, questions)).toEqual({
      image: "python:3.14-slim",
      hours: 2,
      allowDependencyDownloads: false,
      acceptAlreadyMet: false,
      prepare: [],
    });
    expect(asked.at(-1)).toMatch(/^Autopilot builds the approved plan unattended/);
  });

  it("confirms the manager's checks, asks about milestones and the Planner, and approves", async () => {
    const preview: AutopilotStartPreview = {
      approve: true,
      suggestedChecks: ["python -m unittest discover -s tests"],
      goal: {
        milestones: 2,
        planner: { name: "frontier-sol", advisory: false, external: true, destination: "external" },
      },
      defaultHours: 8,
      defaultImage: "",
    };
    const { questions, asked } = scripted([
      "python:3.14-slim",
      "8",
      "use",
      "pip install -e .",
      "",
      "yes",
      "no",
      "wait",
      "yes",
      "3",
      "go",
    ]);
    expect(await askStartOptions(preview, questions)).toEqual({
      image: "python:3.14-slim",
      hours: 8,
      allowDependencyDownloads: true,
      acceptAlreadyMet: false,
      prepare: ["pip install -e ."],
      checks: ["python -m unittest discover -s tests"],
      checkpoint: "wait",
      allowPlannerDestination: "external",
      plannerSpendCapUsd: 3,
    });
    expect(asked).toContain("The goal: 2 milestones");
    expect(asked.at(-1)).toMatch(/^This approves the proposed plan/);
  });

  it("asks for checks when the manager suggested none, and refuses to build without one", async () => {
    const preview = { ...PLAIN, suggestedChecks: [] };
    const typed = scripted(["img", "1", "make test", "", "", "no", "no", "go"]);
    expect((await askStartOptions(preview, typed.questions))?.checks).toEqual(["make test"]);
    const none = scripted(["img", "1", ""]);
    await expect(askStartOptions(preview, none.questions)).rejects.toThrow(
      "Autopilot needs at least one check",
    );
  });

  it("starts nothing when the owner cancels, or declines the Planner's reach", async () => {
    expect(await askStartOptions(PLAIN, scripted([undefined]).questions)).toBeUndefined();
    expect(
      await askStartOptions(PLAIN, scripted(["img", "1", "", "no", "no", "cancel"]).questions),
    ).toBeUndefined();
    const external: AutopilotStartPreview = {
      ...PLAIN,
      goal: {
        milestones: 1,
        planner: { name: "p", advisory: false, external: true, destination: "external" },
      },
    };
    expect(
      await askStartOptions(
        external,
        scripted(["img", "1", "", "no", "no", "notify", "no"]).questions,
      ),
    ).toBeUndefined();
  });
});
