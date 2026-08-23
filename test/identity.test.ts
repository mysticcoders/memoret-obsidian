import { describe, expect, it } from "vitest";
import * as os from "node:os";

import { fingerprintOf, receiverHost } from "../src/identity.js";

// A fixed key, so the expected fingerprint below pins the derivation rather
// than restating it. Senders reject a receiver whose /ping fingerprint does
// not match the one they paired with, so a change here is a change to the
// protocol and should fail loudly.
const PUBLIC_KEY = "H1kkPZlp5dsZR4WzPeF+Mv+2VYbdcAmDU0P1YtEUmxU=";
const FINGERPRINT = "9415d7ac78c2f917";

describe("fingerprint", () => {
  it("is the first 16 hex characters of sha256 over the raw key", () => {
    expect(fingerprintOf(PUBLIC_KEY)).toBe(FINGERPRINT);
  });

  it("is lowercase hex of a fixed width", () => {
    expect(fingerprintOf(PUBLIC_KEY)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("advertised host", () => {
  // The regression: publishing under os.hostname() claimed the machine's own
  // name from a second mDNS responder. macOS resolved that conflict by
  // renaming itself and keeping the new name, one step further on every
  // plugin load, and every pairing saved a machine name that later moved.
  it("does not borrow the machine's name", () => {
    const host = receiverHost(fingerprintOf(PUBLIC_KEY));
    expect(host).not.toContain(os.hostname().replace(/\.local$/, ""));
  });

  it("is derived from the fingerprint, so it outlives any rename", () => {
    expect(receiverHost(FINGERPRINT)).toBe("memoret-9415d7ac78c2f917");
  });

  it("is a single legal DNS label", () => {
    const host = receiverHost(FINGERPRINT);
    expect(host).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(host.length).toBeLessThanOrEqual(63);
  });
});
