import { connect, createServer } from "node:net";
import { proxyTarget, registryHost, startRegistryProxy } from "@runtime/registry-proxy";
import { sandboxProfile } from "@runtime/sandbox";
import { describe, expect, it } from "vitest";

/** With the proxy's credential unless `bare`, as a command given its environment sends it. */
function signed(proxy: { credential: string }, request: string): string {
  const auth = Buffer.from(`dispatch:${proxy.credential}`).toString("base64");
  return request.replace(/\r\n\r\n$/, `\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`);
}

function exchange(
  proxy: { port: number; credential: string },
  request: string,
  then?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy.port, "127.0.0.1", () => socket.write(signed(proxy, request)));
    let answer = "";
    let sent = false;
    socket.on("data", (chunk) => {
      answer += chunk.toString();
      if (then && !sent && answer.includes("\r\n\r\n")) {
        sent = true;
        socket.write(then);
      }
    });
    socket.on("end", () => resolve(answer));
    socket.on("error", reject);
    setTimeout(() => {
      socket.destroy();
      resolve(answer);
    }, 500);
  });
}

describe("the registry proxy for sandboxed installs (L19)", () => {
  it("knows the registries and nothing else", () => {
    expect(registryHost("registry.npmjs.org")).toBe(true);
    expect(registryHost("FILES.PYTHONHOSTED.ORG")).toBe(true);
    expect(registryHost("cdn.files.pythonhosted.org")).toBe(false);
    expect(registryHost("upload.pypi.org")).toBe(false);
    expect(registryHost("crates.io")).toBe(false);
    expect(registryHost("evil.com\u0000.pypi.org")).toBe(false);
    expect(registryHost("github.com")).toBe(false);
    expect(registryHost("evilregistry.npmjs.org.example")).toBe(false);
    expect(registryHost("npmjs.org")).toBe(false);
  });

  it("reads CONNECT and plain targets", () => {
    expect(proxyTarget("CONNECT pypi.org:443 HTTP/1.1\r\n\r\n")).toEqual({
      host: "pypi.org",
      port: 443,
      connect: true,
    });
    expect(proxyTarget("GET http://repo1.maven.org/x HTTP/1.1\r\n\r\n")).toMatchObject({
      host: "repo1.maven.org",
      port: 80,
    });
    expect(proxyTarget("GET https://pypi.org/ HTTP/1.1\r\n\r\n")).toBe("use CONNECT for HTTPS");
  });

  it("refuses a host that is not a registry", async () => {
    const proxy = await startRegistryProxy();
    const { server } = proxy;
    try {
      const answer = await exchange(proxy, "CONNECT attacker.example:443 HTTP/1.1\r\n\r\n");
      expect(answer).toMatch(/^HTTP\/1.1 403/);
      expect(answer).toContain("not a package registry");
    } finally {
      server.close();
    }
  });

  it("refuses a host with a NUL byte and keeps serving", async () => {
    const proxy = await startRegistryProxy(() => true);
    const { server } = proxy;
    try {
      const answer = await exchange(proxy, "CONNECT evil.com\u0000.pypi.org:443 HTTP/1.1\r\n\r\n");
      expect(answer).toMatch(/^HTTP\/1.1 400/);
      const next = await exchange(proxy, "CONNECT attacker.example:99999 HTTP/1.1\r\n\r\n");
      expect(next).toMatch(/^HTTP\/1.1 /);
    } finally {
      server.close();
    }
  });

  it("tunnels to a permitted destination", async () => {
    const echo = createServer((socket) => socket.on("data", (d) => socket.end(`echo:${d}`)));
    await new Promise<void>((done) => echo.listen(0, "127.0.0.1", done));
    const target = (echo.address() as { port: number }).port;
    const proxy = await startRegistryProxy((host) => host === "127.0.0.1");
    const { server } = proxy;
    try {
      const answer = await exchange(proxy, `CONNECT 127.0.0.1:${target} HTTP/1.1\r\n\r\n`, "hello");
      expect(answer).toContain("200 Connection Established");
      expect(answer).toContain("echo:hello");
    } finally {
      server.close();
      echo.close();
    }
  });

  it("limits a dependency-mode sandbox to the proxy port", () => {
    const profile = sandboxProfile({
      projectRoot: "/p",
      writable: [],
      deniedRead: [],
      network: "dependency",
      proxyPort: 41234,
      tmp: "/t",
    });
    expect(profile).toContain('(allow network-outbound (remote tcp "localhost:41234"))');
    expect(profile).not.toContain("(allow network-outbound)\n");
    const unproxied = sandboxProfile({
      projectRoot: "/p",
      writable: [],
      deniedRead: [],
      network: "dependency",
      tmp: "/t",
    });
    expect(unproxied).toContain("(deny network*)");
    expect(unproxied).not.toContain("allow network-outbound");
  });
});
