import { createHash } from "node:crypto";

/**
 * The receiver's fingerprint: the first 16 hex characters of the SHA-256 of
 * the raw public key.
 *
 * Senders compare this against what `/ping` returns to be sure they are
 * talking to the receiver they paired with rather than another one on the
 * same network, so the derivation has to stay byte-for-byte identical to
 * every other implementation of the protocol.
 */
export function fingerprintOf(publicKeyBase64: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKeyBase64, "base64"))
    .digest("hex")
    .slice(0, 16);
}

/**
 * The `.local` name this receiver publishes and answers to, without the
 * suffix.
 *
 * Deliberately not the machine's own hostname. `bonjour-service` is a second
 * mDNS responder living inside Obsidian, and publishing A records under the
 * host name means claiming that name on the network. Claiming the one the
 * operating system already owns is a conflict: macOS yields, renames itself
 * to `<name>-2`, and persists it — so every plugin load walked the machine's
 * name one further from where it started.
 *
 * A name derived from the fingerprint is one nothing else claims, and it is
 * stable for the life of the keypair. That also fixes the pairing payload,
 * which used to record a machine name that drifted afterwards and left
 * senders with a `.local` fallback address that resolved to nothing.
 */
export function receiverHost(fingerprint: string): string {
  return `memoret-${fingerprint}`;
}
