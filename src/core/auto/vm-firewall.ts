/**
 * L29: an auto run's setup step gets the network to download dependencies, and
 * on colima a container on the VM's bridge reaches services on the owner's Mac
 * (even ones bound to 127.0.0.1) through the VM's gateway, and the LAN. These
 * rules, run as root in the VM, leave such a container the internet and the
 * VM's DNS only. Auto mode checks for them before a networked setup.
 *
 * The VM resolves names through public servers: a resolver on a private
 * network is out of a container's reach like the rest of it, and colima's own
 * (192.168.5.4 on newer VMs) can stop answering altogether.
 */
export const PUBLIC_RESOLVERS = ["1.1.1.1", "9.9.9.9"];

export const VM_FIREWALL_RULES = [
  `rm -f /etc/resolv.conf; printf '${PUBLIC_RESOLVERS.map((ip) => `nameserver ${ip}\\n`).join("")}' > /etc/resolv.conf`,
  "iptables -N DOCKER-USER 2>/dev/null || true",
  "iptables -F DOCKER-USER",
  "iptables -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
  ...[
    "192.168.0.0/16",
    "10.20.0.0/8",
    "172.16.0.0/12",
    "100.64.0.0/10",
    "169.254.0.0/16",
    "224.0.0.0/4",
  ].map((net) => `iptables -A DOCKER-USER -d ${net} -j DROP`),
  "iptables -A DOCKER-USER -j RETURN",
  "iptables -N DISPATCH-VM-INPUT 2>/dev/null || true",
  "iptables -F DISPATCH-VM-INPUT",
  "iptables -A DISPATCH-VM-INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN",
  "iptables -A DISPATCH-VM-INPUT -p udp --dport 53 -j RETURN",
  "iptables -A DISPATCH-VM-INPUT -p tcp --dport 53 -j RETURN",
  "iptables -A DISPATCH-VM-INPUT -j DROP",
  'for dev in docker0 \'br-+\'; do iptables -C INPUT -i "$dev" -j DISPATCH-VM-INPUT 2>/dev/null || iptables -I INPUT -i "$dev" -j DISPATCH-VM-INPUT; done',
  // IPv6, for a VM or network that turns it on: local, multicast and mapped ranges.
  'if command -v ip6tables >/dev/null; then ip6tables -N DOCKER-USER 2>/dev/null || true; ip6tables -F DOCKER-USER; for net in fc00::/7 fe80::/10 ff00::/8 ::1/128 ::ffff:0:0/96; do ip6tables -A DOCKER-USER -d "$net" -j DROP; done; ip6tables -A DOCKER-USER -j RETURN; fi',
];

/** The command that applies the rules to colima's `dispatch-auto` VM. */
export function vmFirewallCommand(profile = "dispatch-auto"): string {
  return `colima ssh --profile ${profile} -- sudo sh -c '${VM_FIREWALL_RULES.join("; ").replaceAll("'", "'\\''")}'`;
}

/** A name any working resolver knows, to check that setup can look names up. */
export const DNS_PROBE_NAME = "example.com";

/**
 * Prints UNRESOLVED when the container cannot look up `name`. Prints nothing
 * when the image has no getent, which is then not checked.
 */
export function dnsProbeScript(name = DNS_PROBE_NAME): string {
  return `if command -v getent >/dev/null 2>&1; then t=; command -v timeout >/dev/null 2>&1 && t="timeout 8"; $t getent hosts ${name} >/dev/null 2>&1 || echo UNRESOLVED; fi`;
}

/** Names a container may use for the machine running the VM. */
export const HOST_NAMES = ["host.lima.internal", "host.docker.internal", "192.168.5.2"];

/**
 * A bash probe that prints REACHED:<name> for each host name it can connect to on
 * `port`. Each attempt gets two seconds: a firewall that drops the traffic leaves
 * the connect hanging, and that counts as unreachable. Plain bash, so it needs
 * nothing from the toolchain image.
 */
export function hostProbeScript(port: number, names: string[] = HOST_NAMES): string {
  const attempt = (host: string) =>
    `(exec 3<>/dev/tcp/${host}/${port}) 2>/dev/null & p=$!; for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 $p 2>/dev/null || break; sleep 0.2; done; if kill -0 $p 2>/dev/null; then kill $p 2>/dev/null; wait $p 2>/dev/null; elif wait $p; then echo REACHED:${host}; fi`;
  return names.map(attempt).concat("true").join("; ");
}
