import { runChecks, VACUOUS_CHECK } from "@core/exec/checks";
import { expect, it } from "vitest";

const live = () => new AbortController().signal;

it("runs every check, keeps going past a failing exit, and passes only when all pass", async () => {
  const seen: string[] = [];
  const view = await runChecks(
    ["lint", "test"],
    async (command) => {
      seen.push(command);
      return command === "lint"
        ? { exitCode: 1, output: "1 problem" }
        : { exitCode: 0, output: "3 passed" };
    },
    live(),
    { stopOnError: true },
  );
  expect(seen).toEqual(["lint", "test"]);
  expect(view.status).toBe("failed");
  expect(view.reason).toMatch(/failed or were not all run/);
});

it("fails a test command that ran no tests, and stops there when asked", async () => {
  const seen: string[] = [];
  const view = await runChecks(
    ["pytest", "ruff"],
    async (command) => {
      seen.push(command);
      return { exitCode: 0, output: command === "pytest" ? "no tests ran in 0.01s" : "ok" };
    },
    live(),
    { stopOnError: true },
  );
  expect(seen).toEqual(["pytest"]);
  expect(view.commands[0].error).toBe(VACUOUS_CHECK);
  expect(view.status).toBe("failed");
});

it("records an executor error as a failed check, or rethrows it when the path needs that", async () => {
  const boom = async () => {
    throw new Error("container gone");
  };
  const view = await runChecks(["test"], boom, live());
  expect(view.commands[0]).toMatchObject({ exitCode: null, error: "container gone" });
  await expect(runChecks(["test"], boom, live(), { rethrow: () => true })).rejects.toThrow(
    "container gone",
  );
});

it("is unverified with no checks, and says it was interrupted", async () => {
  expect((await runChecks([], async () => ({ exitCode: 0, output: "" }), live())).status).toBe(
    "unverified",
  );
  const stop = new AbortController();
  stop.abort();
  const view = await runChecks(["test"], async () => ({ exitCode: 0, output: "" }), stop.signal);
  expect(view).toMatchObject({ status: "unverified", reason: "Interrupted" });
});
