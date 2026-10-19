import { normalizeLocalManager, probeLocalManager } from "@core/local-manager";
import { FileStore } from "@core/store";
import { expect, it } from "vitest";
import { tempDir } from "./support/temp-dir";

const local = {
  enabled: true,
  url: "http://127.0.0.1:11434/v1",
  token: "local-secret",
  model: "local-manager",
  contextTokens: 32768,
  maxOutputTokens: 2048,
};

it("accepts loopback manager servers and rejects other destinations", () => {
  expect(normalizeLocalManager(local).url).toBe("http://127.0.0.1:11434");
  expect(() => normalizeLocalManager({ ...local, url: "https://models.example.com" })).toThrow(
    /this computer/i,
  );
});

it("tests that the configured model is actually listed", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: [{ id: "local-manager", context_length: 32768, max_output_tokens: 2048 }],
      }),
      { status: 200 },
    );
  await expect(probeLocalManager(local, fetchImpl as typeof fetch)).resolves.toMatchObject({
    ok: true,
    model: "local-manager",
    reportedContextTokens: 32768,
  });
});

it("keeps the local token out of public connection state", async () => {
  const store = new FileStore(await tempDir("dispatch-local-manager-"));
  await store.init();
  await store.saveConnection({
    url: "http://poundlock",
    token: "poundlock",
    roles: {},
    localManager: local,
  });
  expect((await store.getConnection()).localManager?.token).toBe("local-secret");
  const publicState = await store.getConnectionPublic();
  expect(publicState.localManager?.tokenConfigured).toBe(true);
  expect(JSON.stringify(publicState)).not.toContain("local-secret");
});
