/**
 * A project's two network switches (ADR 015): whether its commands reach the
 * internet, and whether they reach the owner's own network.
 */
export interface ProjectNetwork {
  internet?: boolean;
  localNetwork?: boolean;
  /** The manager and Planner may search the web and fetch public pages (off unless set). */
  webSearch?: boolean;
}

export interface NetworkReach {
  internet: boolean;
  localNetwork: boolean;
}

/** The switches with their defaults: internet on, local network off. */
export function projectReach(policy?: { network?: ProjectNetwork }): NetworkReach {
  return {
    internet: policy?.network?.internet ?? true,
    localNetwork: policy?.network?.localNetwork ?? false,
  };
}

/** One line for settings, status and the TUI. */
export function describeReach(reach: NetworkReach): string {
  if (reach.internet && reach.localNetwork) return "Internet and local network";
  if (reach.internet) return "Internet only";
  if (reach.localNetwork) return "Local network only";
  return "No network";
}

export type AddressClass = "public" | "private" | "loopback" | "refused";

/**
 * Where an address points. "private" is the owner's networks: RFC 1918, CGNAT
 * (Tailscale), link-local and unique-local IPv6. "loopback" is this Mac's own
 * services. Multicast, broadcast and reserved addresses are refused either way.
 */
export function classifyAddress(address: string): AddressClass {
  const v4 = ipv4Bytes(address);
  if (v4) return classifyIpv4(v4);
  const v6 = ipv6Bytes(address);
  if (!v6) return "refused";
  const zeros = (from: number, to: number) => v6.slice(from, to).every((byte) => byte === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible) carry an IPv4 address.
  if (zeros(0, 10) && v6[10] === 0xff && v6[11] === 0xff) return classifyIpv4(v6.slice(12));
  if (zeros(0, 12)) {
    if (zeros(12, 15) && v6[15] === 1) return "loopback";
    if (zeros(12, 16)) return "refused";
    return classifyIpv4(v6.slice(12));
  }
  const [a, b] = [v6[0]!, v6[1]!];
  if (a === 0xff) return "refused";
  // Unique-local fc00::/7, link-local fe80::/10 and the old site-local fec0::/10.
  if ((a & 0xfe) === 0xfc || (a === 0xfe && (b & 0xc0) !== 0)) return "private";
  // NAT64, 6to4 and Teredo carry IPv4 addresses this check cannot see; documentation.
  if (a === 0x00 && b === 0x64 && v6[2] === 0xff && v6[3] === 0x9b) return "refused";
  if (a === 0x20 && b === 0x02) return "refused";
  if (a === 0x20 && b === 0x01 && v6[2] === 0 && v6[3] === 0) return "refused";
  if (a === 0x20 && b === 0x01 && v6[2] === 0x0d && v6[3] === 0xb8) return "refused";
  return "public";
}

function classifyIpv4(bytes: number[]): AddressClass {
  const [a, b, c] = [bytes[0]!, bytes[1]!, bytes[2]!];
  if (a === 0 || a >= 224) return "refused";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  // Documentation and benchmarking ranges are not destinations.
  if (a === 192 && b === 0 && c === 2) return "refused";
  if (a === 198 && (b === 18 || b === 19)) return "refused";
  return "public";
}

/** A dotted-quad IPv4 address as four bytes, or undefined. */
function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
}

/** An IPv6 address in any textual form as sixteen bytes, or undefined. */
function ipv6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(/^\[|\]$/g, "");
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return undefined;
  // A trailing dotted quad stands for the last two groups.
  const dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  let tail: number[] = [];
  if (dotted) {
    const v4 = ipv4Bytes(dotted[2]!);
    if (!v4) return undefined;
    tail = v4;
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string) => (part ? part.split(":") : []);
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const wanted = 8 - tail.length / 2;
  const missing = wanted - head.length - rest.length;
  if (halves.length === 1 ? missing !== 0 : missing < 0) return undefined;
  const all = [...head, ...Array(missing).fill("0"), ...rest];
  if (!all.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  return [
    ...all.flatMap((group) => {
      const value = Number.parseInt(group, 16);
      return [value >> 8, value & 0xff];
    }),
    ...tail,
  ];
}

/**
 * Whether `reach` lets a command connect to an address of this class. This
 * Mac's own services are part of the local network.
 */
export function reachAllows(reach: NetworkReach, kind: AddressClass): boolean {
  switch (kind) {
    case "public":
      return reach.internet;
    case "private":
      return reach.localNetwork;
    case "loopback":
      return reach.localNetwork;
    default:
      return false;
  }
}
