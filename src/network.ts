import type * as os from "node:os";

/**
 * A stable summary of the addresses mDNS would advertise for this machine.
 *
 * Mirrors the filter bonjour-service applies when it builds A and AAAA
 * records — skipping loopback and interfaces with no hardware address — so
 * a change here is exactly a change in what the published records ought to
 * say. The service builds those records once, when it is published, and
 * keeps answering with them after the machine moves to another network;
 * comparing this summary is how the plugin notices it has to publish again.
 */
export function advertisedAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string {
  const addresses: string[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.mac === "00:00:00:00:00:00") continue;
      addresses.push(entry.address);
    }
  }
  return addresses.sort().join(",");
}
