import * as tls from "node:tls";

interface CertificateAuthorityApi {
  getCACertificates(type: "default" | "system"): string[];
  setDefaultCACertificates(certificates: string[]): void;
}

export function includeSystemCertificateAuthorities(api: CertificateAuthorityApi): number {
  const system = api.getCACertificates("system");
  if (!system.length) return 0;
  const certificates = [...new Set([...api.getCACertificates("default"), ...system])];
  api.setDefaultCACertificates(certificates);
  return system.length;
}

export function configureSystemCertificateAuthorities(): number {
  const api = tls as typeof tls & {
    setDefaultCACertificates?: (certificates: string[]) => void;
  };
  if (typeof api.getCACertificates !== "function" || !api.setDefaultCACertificates) return 0;
  return includeSystemCertificateAuthorities(api as CertificateAuthorityApi);
}
