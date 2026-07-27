import type sodiumType from "libsodium-wrappers";

/**
 * Loads the CommonJS build of libsodium-wrappers, whose ESM distribution is
 * broken. The ambient require lets esbuild statically include it in the
 * plugin bundle.
 *
 * This is the one place the vendored contract deliberately differs from the
 * monorepo's copy, which also carries a `createRequire(import.meta.url)`
 * fallback for Node ESM. The plugin only ever runs inside Obsidian's
 * CommonJS context, where that branch is unreachable — and `import.meta` is
 * empty under a CommonJS output format, so bundling it left a fallback in
 * the artifact that could not have worked had anything reached it. esbuild
 * warned about exactly that.
 */
function loadSodium(): typeof sodiumType {
  return require("libsodium-wrappers");
}

const _sodium: typeof sodiumType = loadSodium();

export const SEALED_MAGIC = new Uint8Array([0x56, 0x56, 0x53, 0x42, 0x01]);

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

/**
 * Resolves the libsodium WASM runtime; every other function in this module
 * awaits it internally so callers never have to sequence initialization.
 */
async function sodium() {
  await _sodium.ready;
  return _sodium;
}

/**
 * Generates the plugin-owned X25519 keypair. The private key must never
 * leave the plugin host; only the public key is shared with iOS at pairing.
 */
export async function generateKeypair(): Promise<Keypair> {
  const s = await sodium();
  const kp = s.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

/**
 * Seals plaintext bytes to a recipient public key using crypto_box_seal
 * (ephemeral X25519 + XSalsa20-Poly1305) and prepends the VVSB v1 magic so
 * receivers can reject garbage and future schemes can be versioned.
 */
export async function seal(
  plaintext: Uint8Array,
  recipientPublicKey: Uint8Array,
): Promise<Uint8Array> {
  const s = await sodium();
  const sealed = s.crypto_box_seal(plaintext, recipientPublicKey);
  const out = new Uint8Array(SEALED_MAGIC.length + sealed.length);
  out.set(SEALED_MAGIC, 0);
  out.set(sealed, SEALED_MAGIC.length);
  return out;
}

/**
 * Opens a VVSB v1 sealed blob with the recipient keypair, throwing on a
 * bad magic header or failed authentication.
 */
export async function open(
  blob: Uint8Array,
  keypair: Keypair,
): Promise<Uint8Array> {
  const s = await sodium();
  if (
    blob.length < SEALED_MAGIC.length ||
    !SEALED_MAGIC.every((b, i) => blob[i] === b)
  ) {
    throw new Error("sealed blob: bad magic header (not a VVSB v1 blob)");
  }
  const sealed = blob.subarray(SEALED_MAGIC.length);
  try {
    return s.crypto_box_seal_open(sealed, keypair.publicKey, keypair.privateKey);
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
  const s = await sodium();
  return s.to_base64(bytes, s.base64_variants.ORIGINAL);
}

/**
 * Decodes standard base64 into bytes for keys and pairing payloads.
 */
export async function fromBase64(text: string): Promise<Uint8Array> {
  const s = await sodium();
  return s.from_base64(text, s.base64_variants.ORIGINAL);
}
