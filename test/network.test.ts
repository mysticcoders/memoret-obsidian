import { describe, expect, it } from "vitest";
import type * as os from "node:os";

import { advertisedAddresses } from "../src/network.js";

function entry(
  address: string,
  overrides: Partial<os.NetworkInterfaceInfo> = {},
): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: address.includes(":") ? "IPv6" : "IPv4",
    mac: "70:8c:f2:b4:83:69",
    internal: false,
    cidr: null,
    ...overrides,
  } as os.NetworkInterfaceInfo;
}

describe("advertised addresses", () => {
  // The regression: records built on one network kept being served on the
  // next, so the receiver's name resolved to an address it no longer held.
  it("changes when the machine moves to another network", () => {
    const home = advertisedAddresses({ en0: [entry("192.168.4.39")] });
    const away = advertisedAddresses({ en0: [entry("172.21.21.235")] });
    expect(home).not.toBe(away);
  });

  it("does not change when only the interface order does", () => {
    const a = advertisedAddresses({
      en0: [entry("172.21.21.235")],
      utun4: [entry("fd7a:115c:a1e0::1")],
    });
    const b = advertisedAddresses({
      utun4: [entry("fd7a:115c:a1e0::1")],
      en0: [entry("172.21.21.235")],
    });
    expect(a).toBe(b);
  });

  it("skips what bonjour-service would never advertise", () => {
    expect(
      advertisedAddresses({
        lo0: [entry("127.0.0.1", { internal: true })],
        utun0: [entry("fe80::1", { mac: "00:00:00:00:00:00" })],
        en0: [entry("172.21.21.235")],
      }),
    ).toBe("172.21.21.235");
  });
});
