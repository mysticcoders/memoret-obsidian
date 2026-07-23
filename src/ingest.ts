import { open, parsePackage, type Keypair } from "./contract/index.js";

export interface VaultFS {
  exists(path: string): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
}

export interface IngestResult {
  captureId: string;
  duplicate: boolean;
  notePath?: string;
  audioPath?: string;
}

/**
 * Returns the parent directory of a vault-relative path, or empty string
 * for root-level paths.
 */
function parentDir(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

/**
 * Appends a short capture-id suffix before the extension so a colliding
 * delivery never overwrites an existing vault file.
 */
function suffixPath(path: string, captureId: string): string {
  const short = captureId.slice(0, 8);
  const idx = path.lastIndexOf(".");
  return idx === -1 ? `${path}-${short}` : `${path.slice(0, idx)}-${short}${path.slice(idx)}`;
}

/**
 * Picks a collision-free destination, preferring the manifest path and
 * falling back to a capture-id-suffixed variant.
 */
async function resolveDestination(
  fs: VaultFS,
  path: string,
  captureId: string,
): Promise<string> {
  if (!(await fs.exists(path))) return path;
  return suffixPath(path, captureId);
}

/**
 * The plugin's ingest core: opens a sealed blob with the plugin keypair,
 * validates the package, and writes the note plus audio attachment at their
 * manifest paths. Deduplicates by capture_id so redelivery over any
 * transport is idempotent. Throws on bad crypto or an invalid package;
 * callers decide what to do with the offending blob.
 */
export async function ingestSealedBlob(
  blob: Uint8Array,
  keypair: Keypair,
  fs: VaultFS,
  alreadyIngested: ReadonlySet<string>,
): Promise<IngestResult> {
  const pkg = parsePackage(await open(blob, keypair));
  const { manifest } = pkg;
  if (alreadyIngested.has(manifest.capture_id)) {
    return { captureId: manifest.capture_id, duplicate: true };
  }
  const notePath = await resolveDestination(
    fs,
    manifest.vault_note_path,
    manifest.capture_id,
  );
  const audioPath = await resolveDestination(
    fs,
    manifest.attachment_path,
    manifest.capture_id,
  );
  for (const dir of new Set([parentDir(notePath), parentDir(audioPath)])) {
    if (dir.length > 0) await fs.mkdirp(dir);
  }
  await fs.writeBinary(audioPath, pkg.audio);
  await fs.writeText(notePath, pkg.transcript);
  return {
    captureId: manifest.capture_id,
    duplicate: false,
    notePath,
    audioPath,
  };
}
