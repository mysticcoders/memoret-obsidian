import { open, parsePackage, type Keypair } from "./contract/index.js";

export interface VaultFS {
  exists(path: string): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
  writeText(path: string, text: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  /** Removes a file this ingest wrote. Absent files are not an error. */
  remove(path: string): Promise<void>;
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
 * Appends a suffix before the extension so a colliding delivery never
 * overwrites an existing vault file.
 */
function suffixPath(path: string, suffix: string): string {
  const idx = path.lastIndexOf(".");
  return idx === -1
    ? `${path}-${suffix}`
    : `${path.slice(0, idx)}-${suffix}${path.slice(idx)}`;
}

/**
 * How many suffixed names to try before giving up. Reaching this means
 * something is wrong with the vault rather than with the capture, and
 * failing loudly beats spinning forever.
 */
const MAX_COLLISION_ATTEMPTS = 1000;

/**
 * Picks a destination nothing already occupies.
 *
 * The first fallback carries the whole capture id, not a prefix of it:
 * needing a fallback at all means two captures already want one name, and
 * truncating the id is what makes a second clash likelier. The counter
 * after it guarantees the search ends even then — the previous version
 * returned its single alternate without checking, so a second collision
 * quarantined the capture in Obsidian and silently overwrote in the CLI.
 */
async function resolveDestination(
  fs: VaultFS,
  path: string,
  captureId: string,
): Promise<string> {
  if (!(await fs.exists(path))) return path;
  const withId = suffixPath(path, captureId);
  if (!(await fs.exists(withId))) return withId;
  for (let n = 2; n < MAX_COLLISION_ATTEMPTS; n += 1) {
    const candidate = suffixPath(path, `${captureId}-${String(n)}`);
    if (!(await fs.exists(candidate))) return candidate;
  }
  throw new Error(`no free destination for ${path}`);
}

/**
 * Removes what a failed ingest managed to write, so a retry starts from an
 * empty vault rather than around its own leftovers.
 *
 * Failures here are swallowed: the caller is already unwinding with the
 * error that matters, and replacing it with a cleanup error would hide the
 * reason the capture failed.
 */
export async function discard(fs: VaultFS, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    try {
      await fs.remove(path);
    } catch {
      // Nothing useful to do; the original failure is still thrown.
    }
  }
}

/**
 * Points the note's audio embed at where the attachment actually landed.
 *
 * The sender writes the embed from its own manifest path, but the vault
 * decides placement and a collision can change the filename, so without
 * this the note links to a file that is not there.
 *
 * The whole line is matched rather than the path alone, so a transcript
 * that happens to quote the same text is left intact, and only the first
 * such line is rewritten — the contract emits exactly one, immediately
 * after the frontmatter.
 */
export function rewriteAudioEmbed(
  transcript: string,
  fromPath: string,
  toPath: string,
): string {
  if (fromPath === toPath) return transcript;
  const lines = transcript.split("\n");
  const index = lines.indexOf(`![[${fromPath}]]`);
  if (index === -1) return transcript;
  lines[index] = `![[${toPath}]]`;
  return lines.join("\n");
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
  // Audio lands before the note, so a failure between them would leave a
  // recording nothing refers to — and the redelivery would resolve around
  // that orphan into a collision name rather than replacing it.
  const written: string[] = [];
  try {
    if (pkg.audio !== undefined && audioPath !== undefined) {
      await fs.writeBinary(audioPath, pkg.audio);
      written.push(audioPath);
    }
    // The embed the sender wrote names its own manifest path, which is only
    // where the audio ends up when this vault neither relocates nor renames
    // it. Written after the destination is settled, never before.
    const transcript =
      audioPath !== undefined && manifest.attachment_path !== undefined
        ? rewriteAudioEmbed(pkg.transcript, manifest.attachment_path, audioPath)
        : pkg.transcript;
    await fs.writeText(notePath, transcript);
    written.push(notePath);
  } catch (err) {
    await discard(fs, written);
    throw err;
  }
  return {
    captureId: manifest.capture_id,
    duplicate: false,
    notePath,
    audioPath,
  };
}
