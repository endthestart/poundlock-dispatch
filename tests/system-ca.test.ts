import { includeSystemCertificateAuthorities } from "@runtime/system-ca";
import { expect, it, vi } from "vitest";

it("adds system certificate authorities to the default TLS trust set", () => {
  const setDefaultCACertificates = vi.fn();
  const count = includeSystemCertificateAuthorities({
    getCACertificates: (type) =>
      type === "default" ? ["bundled", "shared"] : ["system", "shared"],
    setDefaultCACertificates,
  });

  expect(count).toBe(2);
  expect(setDefaultCACertificates).toHaveBeenCalledWith(["bundled", "shared", "system"]);
});

it("leaves the default trust set unchanged when the OS exposes no certificates", () => {
  const setDefaultCACertificates = vi.fn();
  const count = includeSystemCertificateAuthorities({
    getCACertificates: (type) => (type === "default" ? ["bundled"] : []),
    setDefaultCACertificates,
  });

  expect(count).toBe(0);
  expect(setDefaultCACertificates).not.toHaveBeenCalled();
});
