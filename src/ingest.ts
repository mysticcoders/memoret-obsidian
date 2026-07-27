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

/** Date-derived nesting added beneath a configured folder. */
export type DateSubfolders = "none" | "month" | "day";

/**
 * Where this vault wants captures to land.
 *
 * A manifest's paths are a suggestion from whichever device made the
 * recording. Left to them, the vault's layout is decided by the phone, and
 * every paired device has to agree on it. A folder set here wins, and only
 * the sender's filename is kept.
 *
 * Every field is optional, and an absent folder keeps the manifest path
 * untouched — which is what releases before settings existed did.
 */
export interface Placement {
  noteFolder?: string;
  attachmentFolder?: string;
  dateSubfolders?: DateSubfolders;
}

/**
 * Splits an ISO timestamp into the folder segments a date nesting wants,
 * returning none if the timestamp is not a plain calendar date — a
 * malformed one should flatten the capture into the folder, never invent
 * directories named after garbage.
 */
function dateSegments(createdAt: string, mode: DateSubfolders): string[] {
  if (mode === "none") return [];
  const date = createdAt.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const [year, month, day] = date.split("-");
  if (year === undefined || month === undefined || day === undefined) return [];
  return mode === "month" ? [year, month] : [year, month, day];
}

/**
 * Rewrites a manifest path into the configured folder, keeping the
 * sender's filename and adding any date nesting.
 *
 * Taking the basename also narrows what the sender controls: the filename
 * alone, rather than the whole path. The manifest is already checked
 * against isSafeVaultPath when the package is parsed, so this is defence
 * in depth rather than the only guard.
 */
export function placeInFolder(
  manifestPath: string,
  folder: string | undefined,
  createdAt: string,
  dateSubfolders: DateSubfolders = "none",
): string {
  if (folder === undefined) return manifestPath;
  const filename = manifestPath.slice(manifestPath.lastIndexOf("/") + 1);
  const segments = [
    ...folder.split("/"),
    ...dateSegments(createdAt, dateSubfolders),
  ].filter((s) => s.length > 0);
  return [...segments, filename].join("/");
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
  placement: Placement = {},
): Promise<IngestResult> {
  const pkg = parsePackage(await open(blob, keypair));
  const { manifest } = pkg;
  if (alreadyIngested.has(manifest.capture_id)) {
    return { captureId: manifest.capture_id, duplicate: true };
  }
  const notePath = await resolveDestination(
    fs,
    placeInFolder(
      manifest.vault_note_path,
      placement.noteFolder,
      manifest.created_at,
      placement.dateSubfolders,
    ),
    manifest.capture_id,
  );
  // A link capture has no recording, so there is no attachment to place.
  const audioPath =
    pkg.audio !== undefined && manifest.attachment_path !== undefined
      ? await resolveDestination(
          fs,
          placeInFolder(
            manifest.attachment_path,
            placement.attachmentFolder,
            manifest.created_at,
            placement.dateSubfolders,
          ),
          manifest.capture_id,
        )
      : undefined;
  const dirs = new Set([parentDir(notePath)]);
  if (audioPath !== undefined) dirs.add(parentDir(audioPath));
  for (const dir of dirs) {
    if (dir.length > 0) await fs.mkdirp(dir);
  }
  if (pkg.audio !== undefined && audioPath !== undefined) {
    await fs.writeBinary(audioPath, pkg.audio);
  }
  await fs.writeText(notePath, pkg.transcript);
  return {
    captureId: manifest.capture_id,
    duplicate: false,
    notePath,
    audioPath,
  };
}
