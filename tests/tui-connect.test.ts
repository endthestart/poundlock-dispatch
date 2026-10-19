/**
 * `/connect`: the terminal sets the controller address and token itself, on
 * the same host, store and files as the desktop app's setup, and tests the
 * connection the way its Test connection button does. The token is asked for
 * hidden and must not turn up anywhere a later reader could find it.
 */

import { readFile, stat } from "node:fs/promises";
import { ApprovalBroker } from "@core/approval-broker";
import { DispatchHost, type HostDependencies } from "@core/host/dispatch-host";
import { ProjectOrchestrator } from "@core/orchestration";
import { ProjectLifecycle } from "@core/project-lifecycle";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { hostCommandPort } from "@runtime/host-command";
import { TuiApp } from "@tui/app";
import { COMMAND_DEFS } from "@tui/commands";
import { connectController, controllerAddressError } from "@tui/connect";
import { SecretInput } from "@tui/prompt";
import { renderSetup } from "@tui/render";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countingManager,
  planTask,
  recordingWorker,
  workflowFixture,
} from "./support/workflow-fixture";

const TOKEN = "pdk_live_9f8e7d6c5b4a39281706";
const URL_ = "http://controller.test:7331";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A controller that accepts exactly `accepts` and records every request it saw. */
function controllerFetch(accepts: string, seen: Array<{ url: string; auth: string }> = []) {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    seen.push({ url, auth });
    if (url.endsWith("/readyz")) return json({ status: "ready", version: "0.9.9" });
    if (auth !== `Bearer ${accepts}`)
      return json({ error: { message: "valid API token required" } }, 401);
    if (url.endsWith("/api/v1/job-options"))
      return json({
        role: "operator",
        permissions: ["jobs:read", "jobs:submit", "jobs:cancel"],
        models: [],
        harnesses: [],
        git_hosts: [],
        outbound_network_allowed: false,
        source_limits: { bytes: 1024, files: 10 },
      });
    if (url.endsWith("/v1/models")) return json({ object: "list", data: [{ id: "coding" }] });
    if (url.endsWith("/api/v1/usage")) return json({ managed_identities: [] });
    if (url.endsWith("/api/v1/capabilities"))
      return json({
        api_major: 1,
        contract_revision: 5,
        features: [
          "access_preflight",
          "availability_reasons",
          "data_destination",
          "durable_jobs",
          "external_invoke_permission",
          "managed_application_identities",
          "routing_revision",
          "usage_summary",
          "verifier_toolchain",
        ],
      });
    return json({ error: { message: `unexpected ${url}` } }, 404);
  }) as typeof fetch;
}

async function hostFixture() {
  const fixture = await workflowFixture({ prefix: "tui-connect-" });
  const { manager } = countingManager(fixture.store, { tasks: [planTask("Task one")] });
  const { worker } = recordingWorker();
  const approvals = new ApprovalBroker(() => {
    void host.emitState();
  });
  const deps: HostDependencies = {
    worker: () => worker,
    managerProvider: () => ({
      get: async () => manager,
      reset: async () => undefined,
      abort: () => undefined,
      clear: () => undefined,
    }),
    orchestrator: (dependencies) =>
      new ProjectOrchestrator({
        hostCommands: hostCommandPort,
        ...dependencies,
        clientFor: async () => fixture.backend,
      }),
    lifecycle: (dependencies) => new ProjectLifecycle(dependencies),
  };
  const host = new DispatchHost(
    { dataRoot: fixture.store.layout.root },
    fixture.store,
    approvals,
    deps,
  );
  await host.selectProject(fixture.project.id);
  return { fixture, host };
}

/** Answers for the two questions, in order; `undefined` cancels that question. */
function answers(address: string | undefined, token: string | undefined) {
  const asked: string[] = [];
  return {
    asked,
    prompts: {
      address: async (current: string) => {
        asked.push(`address:${current}`);
        return address;
      },
      token: async (saved: boolean) => {
        asked.push(`token:${saved ? "saved" : "none"}`);
        return token;
      },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connecting from the terminal", () => {
  it("saves the address and token in the desktop app's own files, then tests them", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.clearConnection();
    const seen: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal("fetch", controllerFetch(TOKEN, seen));
    const { prompts } = answers(URL_, TOKEN);

    const outcome = await connectController(host, prompts);

    expect(outcome.kind).toBe("connected");
    expect(outcome.text).toContain("Connected to Poundlock 0.9.9");
    // The same two files the desktop app reads and writes, split the same way.
    const { connection, secret } = fixture.store.layout.config;
    expect(JSON.parse(await readFile(connection, "utf8")).url).toBe(URL_);
    expect(JSON.parse(await readFile(secret, "utf8")).token).toBe(TOKEN);
    expect(await readFile(connection, "utf8")).not.toContain(TOKEN);
    expect((await stat(secret)).mode & 0o777).toBe(0o600);
    // And the host the desktop app builds reads it back.
    expect((await host.getConnection()).tokenConfigured).toBe(true);
    expect((await fixture.store.getConnection()).token).toBe(TOKEN);
    // Tested by probing the controller with that token, as Test connection does.
    expect(seen.some((request) => request.url === `${URL_}/readyz`)).toBe(true);
    expect(seen.some((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect((await host.getState()).probe?.ok).toBe(true);
  });

  it("reports a rejected token the way the desktop app does, and keeps what was saved", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.clearConnection();
    vi.stubGlobal("fetch", controllerFetch("some-other-token"));
    const outcome = await connectController(host, answers(URL_, TOKEN).prompts);
    expect(outcome.kind).toBe("failed");
    expect(outcome.text).toMatch(/connection test failed/);
    expect(outcome.text).toMatch(/\/connect/);
    expect(outcome.text).not.toContain(TOKEN);
    expect((await fixture.store.getConnection()).url).toBe(URL_);
  });

  it("changes nothing when either question is cancelled", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.clearConnection();
    const seen: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal("fetch", controllerFetch(TOKEN, seen));
    for (const [address, token] of [
      [undefined, TOKEN],
      [URL_, undefined],
    ] as const) {
      const outcome = await connectController(host, answers(address, token).prompts);
      expect(outcome.kind).toBe("cancelled");
    }
    expect(await fixture.store.getConnection()).toMatchObject({ url: "", token: "" });
    expect(seen).toEqual([]);
  });

  it("keeps the saved token when the address is unchanged and the answer is blank", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.saveConnection({ url: URL_, token: TOKEN, roles: {} });
    vi.stubGlobal("fetch", controllerFetch(TOKEN));
    const { prompts, asked } = answers("", "");
    const outcome = await connectController(host, prompts);
    expect(asked).toEqual([`address:${URL_}`, "token:saved"]);
    expect(outcome.kind).toBe("connected");
    expect((await fixture.store.getConnection()).token).toBe(TOKEN);
  });

  it("does not carry a saved token to a different controller", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.saveConnection({ url: URL_, token: TOKEN, roles: {} });
    vi.stubGlobal("fetch", controllerFetch(TOKEN));
    const { prompts, asked } = answers("http://other.test:7331", "");
    await expect(connectController(host, prompts)).rejects.toThrow(/application token/);
    expect(asked).toEqual([`address:${URL_}`, "token:none"]);
    expect(await fixture.store.getConnection()).toMatchObject({ url: URL_, token: TOKEN });
  });

  it("uses an address given on the command line without asking for it", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.clearConnection();
    vi.stubGlobal("fetch", controllerFetch(TOKEN));
    const { prompts, asked } = answers("ignored", TOKEN);
    await connectController(host, prompts, URL_);
    expect(asked).toEqual(["token:none"]);
    expect((await fixture.store.getConnection()).url).toBe(URL_);
  });

  it("refuses an address that is not a full http(s) URL, before saving anything", async () => {
    const { fixture, host } = await hostFixture();
    await fixture.store.clearConnection();
    for (const bad of ["localhost:7331", "controller.test", "ftp://controller.test"]) {
      expect(controllerAddressError(bad)).toMatch(/full URL/);
      await expect(connectController(host, answers(bad, TOKEN).prompts)).rejects.toThrow(
        /full URL/,
      );
    }
    expect(controllerAddressError(URL_)).toBeUndefined();
    expect(controllerAddressError("https://poundlock.example")).toBeUndefined();
    expect((await fixture.store.getConnection()).url).toBe("");
  });
});

describe("the /connect command in the terminal client", () => {
  async function appFixture(options?: { configured?: boolean }) {
    const { fixture, host } = await hostFixture();
    if (options?.configured === false) await fixture.store.clearConnection();
    const listeners: Array<(data: string) => unknown> = [];
    const overlays: Array<{
      component: { handleInput(data: string): void; render(width: number): string[] };
      hidden: boolean;
    }> = [];
    let focused: unknown;
    const tui = {
      addChild: () => undefined,
      removeChild: () => undefined,
      setFocus: (component: unknown) => {
        focused = component;
      },
      showOverlay: (component: unknown) => {
        const entry = {
          component: component as (typeof overlays)[number]["component"],
          hidden: false,
        };
        overlays.push(entry);
        return {
          hide: () => {
            entry.hidden = true;
          },
          setHidden: () => undefined,
          isHidden: () => entry.hidden,
          focus: () => undefined,
          unfocus: () => undefined,
          isFocused: () => !entry.hidden,
          getBounds: () => undefined,
        };
      },
      start: () => undefined,
      stop: () => undefined,
      requestRender: () => undefined,
      addInputListener: (listener: (data: string) => unknown) => {
        listeners.push(listener);
        return () => undefined;
      },
      removeInputListener: () => undefined,
      onTerminalColorSchemeChange: () => () => undefined,
      setTerminalColorSchemeNotifications: () => undefined,
    };
    const app = new TuiApp(
      host,
      tui as unknown as ConstructorParameters<typeof TuiApp>[1],
      vi.fn(),
    );
    await app.start();
    const type = (text: string) => {
      const overlay = overlays.at(-1)!.component;
      for (const char of text) overlay.handleInput(char);
    };
    const lastOverlay = async () => {
      await vi.waitFor(() => expect(overlays.length).toBeGreaterThan(0));
      return overlays.at(-1)!;
    };
    return { fixture, host, app, tui, overlays, type, lastOverlay, focused: () => focused };
  }

  /** Everything the process printed while `work` ran, joined. */
  async function captured(work: () => Promise<unknown>): Promise<string> {
    const written: string[] = [];
    const record = (...args: unknown[]) => {
      written.push(args.map(String).join(" "));
      return true;
    };
    vi.spyOn(process.stdout, "write").mockImplementation(record as never);
    vi.spyOn(process.stderr, "write").mockImplementation(record as never);
    for (const method of ["log", "info", "warn", "error", "debug"] as const)
      vi.spyOn(console, method).mockImplementation(record as never);
    await work();
    return written.join("\n");
  }

  it("is a listed command", () => {
    const connect = COMMAND_DEFS.find((command) => command.name === "/connect");
    expect(connect?.argumentHint).toBe("[address]");
  });

  it("asks for the address, then the token hidden, and leaves the token nowhere readable", async () => {
    const { fixture, host, app, overlays, type, lastOverlay } = await appFixture();
    vi.stubGlobal("fetch", controllerFetch(TOKEN));
    const printed = await captured(async () => {
      const done = app.submitForTest("/connect");
      // The address, offered with what is saved.
      const address = await lastOverlay();
      expect(address.component.render(80).join("\n")).toContain("controller address");
      address.component.handleInput("\r");
      // The token: nothing typed may be drawn.
      await vi.waitFor(() => expect(overlays).toHaveLength(2));
      const secret = overlays[1];
      const drawn: string[] = [];
      for (const char of TOKEN) {
        type(char);
        drawn.push(secret.component.render(80).join("\n"));
      }
      for (const frame of drawn)
        for (let at = 0; at + 5 <= TOKEN.length; at++)
          expect(frame).not.toContain(TOKEN.slice(at, at + 5));
      expect(drawn.at(-1)).toContain("•".repeat(TOKEN.length));
      secret.component.handleInput("\r");
      await done;
      expect(secret.hidden).toBe(true);
    });

    // The token reached the secret file, and only that.
    const state = await host.getState();
    expect((await fixture.store.getConnection()).token).toBe(TOKEN);
    expect(JSON.stringify(state)).not.toContain(TOKEN);
    expect(state.notice?.text).toMatch(/^Connected to Poundlock 0\.9\.9/);
    expect(state.notice?.text).not.toContain(TOKEN);
    expect(printed).not.toContain(TOKEN);
    // Not in the composer's up-arrow history either.
    app.editorForTest().handleInput("\u001b[A");
    expect(app.editorForTest().getText()).toBe("/connect");
    app.editorForTest().handleInput("\u001b[A");
    expect(app.editorForTest().getText()).not.toContain(TOKEN);
  });

  it("refuses a token typed on the command line, and keeps that line out of the history", async () => {
    const { fixture, host, app } = await appFixture();
    await app.submitForTest(`/connect ${URL_} ${TOKEN}`);
    const notice = (await host.getState()).notice;
    expect(notice?.kind).toBe("error");
    expect(notice?.text).toMatch(/Usage: \/connect \[address\]/);
    expect(notice?.text).not.toContain(TOKEN);
    expect((await fixture.store.getConnection()).token).toBe("fixture");
    app.editorForTest().handleInput("\u001b[A");
    expect(app.editorForTest().getText()).not.toContain(TOKEN);
  });

  it("hands every key to the question while it is open", async () => {
    const { app, lastOverlay } = await appFixture();
    const done = app.submitForTest("/connect");
    const address = await lastOverlay();
    // Tab would otherwise switch to the board; Ctrl+C would arm quitting.
    expect(app.shortcut("\t")).toBeUndefined();
    expect(app.shortcut(String.fromCharCode(3))).toBeUndefined();
    address.component.handleInput("\u001b");
    await done;
    expect(app.shortcut("\t")).toBeDefined();
  });

  it("asks straight away on a first run with no connection", async () => {
    const { overlays, lastOverlay } = await appFixture({ configured: false });
    const first = await lastOverlay();
    expect(overlays).toHaveLength(1);
    expect(first.component.render(80).join("\n")).toContain("controller address");
  });

  it("does not interrupt a machine that is already connected", async () => {
    const { overlays } = await appFixture();
    expect(overlays).toHaveLength(0);
  });

  it("points the setup screen at /connect, not at the desktop app", async () => {
    const { host } = await appFixture({ configured: false });
    const lines = renderSetup(await host.getState(), 80).lines.join("\n");
    expect(lines).toContain("/connect");
    expect(lines).not.toMatch(/in the desktop app/);
  });

  it("says how to change a connection that is already set", async () => {
    const { host } = await appFixture();
    const lines = renderSetup(await host.getState(), 80).lines.join("\n");
    expect(lines).toContain("/connect changes the controller or token");
  });
});

describe("the hidden token field", () => {
  function fieldWith(keys: string[]) {
    const field = new SecretInput();
    let submitted: string | undefined;
    let cancelled = false;
    field.onSubmit = (value) => {
      submitted = value;
    };
    field.onCancel = () => {
      cancelled = true;
    };
    field.focused = true;
    for (const key of keys) field.handleInput(key);
    return { field, submitted: () => submitted, cancelled: () => cancelled };
  }
  const ENTER = "\r";
  const LEFT = "\u001b[D";
  const HOME = "\u001b[H";
  const DELETE = "\u001b[3~";

  it("draws a bullet for each character and never the character", () => {
    const { field } = fieldWith([..."s3cret"]);
    const drawn = field.render(40).join("");
    expect(drawn).toContain("\u2022".repeat(6));
    expect(drawn).not.toMatch(/s3cret|[a-z0-9]{3}/);
  });

  it("keeps editing at the end, where the mask shows the cursor", () => {
    // Moving left and typing would put a character somewhere the bullets
    // cannot show, so cursor movement is ignored.
    const moved = fieldWith([..."abcd", LEFT, "X", HOME, "Y", DELETE, ENTER]);
    expect(moved.submitted()).toBe("abcdXY");
  });

  it("supports backspace and paste", () => {
    const typed = fieldWith([..."abcx", "\u007f", ENTER]);
    expect(typed.submitted()).toBe("abc");
    const pasted = fieldWith(["\u001b[200~pdk_live_123\n\u001b[201~", ENTER]);
    expect(pasted.submitted()).toBe("pdk_live_123");
  });

  it("cancels on Escape without submitting", () => {
    const { submitted, cancelled } = fieldWith([..."abc", "\u001b"]);
    expect(cancelled()).toBe(true);
    expect(submitted()).toBeUndefined();
  });

  it("truncates a very long token's bullets to the box", () => {
    const { field } = fieldWith([...Array(200).fill("a")]);
    const [line] = field.render(30);
    expect(line.replace(CURSOR_MARKER, "").length).toBeLessThanOrEqual(30);
  });
});
