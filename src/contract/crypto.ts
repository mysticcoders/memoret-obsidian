import { CipherSuite, HkdfSha256 } from "@hpke/core";
import { DhkemX25519HkdfSha256 } from "@hpke/dhkem-x25519";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

/**
 * `VVSB`, the stable part of the header. The version byte that follows it
 * moves when the crypto does, so anything that only needs to tell our bytes
 * from garbage — the LAN server's pre-check, before a blob is even written
 * to the inbox — should match on this alone rather than pinning a scheme it
 * does not decrypt at that layer.
 */
export const SEALED_MAGIC = new Uint8Array([0x56, 0x56, 0x53, 0x42]);

/** HPKE framing. v1 was libsodium `crypto_box_seal` and is not readable here. */
export const SEALED_VERSION = 0x02;

/**
 * The full 11-byte v2 header: magic, version, then the RFC 9180 codepoints
 * for the suite that sealed the blob — KEM 0x0020 DHKEM(X25519, HKDF-SHA256),
 * KDF 0x0001 HKDF-SHA256, AEAD 0x0003 ChaCha20-Poly1305.
 *
 * Naming the suite costs six bytes and buys the ability to change it later
 * without another format break: a receiver dispatches on these rather than
 * assuming. It is also passed as AEAD associated data, so a blob whose
 * header has been edited fails to open instead of opening as something else.
 */
export const SEALED_HEADER = new Uint8Array([
  0x56, 0x56, 0x53, 0x42, SEALED_VERSION, 0x00, 0x20, 0x00, 0x01, 0x00, 0x03,
]);

/** X25519 encapsulated key, fixed width for this suite. */
const ENCAPSULATED_KEY_BYTES = 32;

/**
 * Domain separation for the HPKE key schedule. Every implementation must
 * pass these exact bytes; a mismatch surfaces only as a failed open, so it
 * is defined once here and mirrored in the iOS app's Sealer.swift.
 */
const INFO = new TextEncoder().encode("memoret/vvsb/2");

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Copies a view into a standalone ArrayBuffer, which is what hpke-js takes.
 * Copying rather than handing over `.buffer` matters for subarrays, whose
 * backing buffer is the whole blob rather than the slice asked for.
 */
function detach(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer;
}

/**
 * Generates the plugin-owned X25519 keypair as raw 32-byte scalars. The
 * private key must never leave the plugin host; only the public key is
 * shared with iOS at pairing.
 *
 * The encoding is the same one libsodium used, so pairings created under v1
 * keep working — the blob format broke, the keys did not.
 */
export async function generateKeypair(): Promise<Keypair> {
  const kp = await suite.kem.generateKeyPair();
  return {
    publicKey: new Uint8Array(await suite.kem.serializePublicKey(kp.publicKey)),
    privateKey: new Uint8Array(
      await suite.kem.serializePrivateKey(kp.privateKey),
    ),
  };
}

/**
 * Seals plaintext to a recipient public key with HPKE base mode and prepends
 * the v2 header.
 *
 * The plugin only ever opens blobs in normal operation; this exists so the
 * vendored contract stays a faithful copy and the tests can seal their own
 * inputs rather than depending on a checked-in ciphertext.
 */
export async function seal(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const key = await suite.kem.deserializePublicKey(detach(recipientPublicKey));
  const sender = await suite.createSenderContext({
    recipientPublicKey: key,
    info: detach(INFO),
  });
  const ciphertext = new Uint8Array(
    await sender.seal(detach(plaintext), detach(SEALED_HEADER)),
  );
  const enc = new Uint8Array(sender.enc);

  const out = new Uint8Array(
    SEALED_HEADER.length + enc.length + ciphertext.length,
  );
  out.set(SEALED_HEADER, 0);
  out.set(enc, SEALED_HEADER.length);
  out.set(ciphertext, SEALED_HEADER.length + enc.length);
  return out;
}

/**
 * Opens a v2 sealed blob with the recipient keypair, throwing on a header
 * that is not ours or on failed authentication.
 *
 * The two failures stay distinct because they mean different things to
 * whoever is looking: a bad header is usually the wrong bytes entirely, a
 * failed open is the wrong vault or a damaged transfer. The plugin routes
 * the second to quarantine rather than retrying it forever.
 */
export async function open(
  blob: Uint8Array,
  keypair: Keypair,
): Promise<Uint8Array> {
  const minimum = SEALED_HEADER.length + ENCAPSULATED_KEY_BYTES;
  if (blob.length < minimum || !SEALED_HEADER.every((b, i) => blob[i] === b)) {
    throw new Error("sealed blob: bad magic header (not a VVSB v2 blob)");
  }

  const enc = blob.subarray(SEALED_HEADER.length, minimum);
  const ciphertext = blob.subarray(minimum);
  try {
    const recipient = await suite.createRecipientContext({
      recipientKey: await suite.kem.deserializePrivateKey(
        detach(keypair.privateKey),
      ),
      enc: detach(enc),
      info: detach(INFO),
    });
    return new Uint8Array(
      await recipient.open(detach(ciphertext), detach(SEALED_HEADER)),
    );
  } catch {
    throw new Error(
      "sealed blob: decryption failed (wrong key or corrupted ciphertext)",
    );
  }
}

/**
 * Encodes bytes as standard base64 for keys and pairing payloads.
 */
export async function toBase64(bytes: Uint8Array): Promise<string> {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Decodes standard base64 into bytes for keys and pairing payloads.
 */
export async function fromBase64(text: string): Promise<Uint8Array> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}
