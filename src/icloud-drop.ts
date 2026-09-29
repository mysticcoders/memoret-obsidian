import * as path from "node:path";
import { SEALED_MAGIC } from "./contract/index.js";

/**
 * Where the iOS app leaves sealed captures for this receiver in iCloud
 * Drive, relative to the user's home directory.
 *
 * The container belongs to the iOS app, but macOS syncs it into every Mac
 * signed in to the same Apple ID whether or not a Mac app declares it, so
 * the plugin can collect from it without being part of the container. Each
 * receiver reads only the folder named by its own fingerprint, so several
 * paired vaults never take each other's captures.
 */
export function dropFolder(home: string, fingerprint: string): string {
  return path.join(
    home,
    "Library/Mobile Documents/iCloud~com~mysticcoders~memoret/Documents/drop",
    fingerprint,
  );
}

/**
 * Whether these bytes start like a sealed blob. Shared by every transport
 * so the LAN receiver and the iCloud collector refuse the same things.
 */
export function isSealedBlob(blob: Uint8Array): boolean {
  return (
    blob.length >= SEALED_MAGIC.length &&
    SEALED_MAGIC.every((b, i) => blob[i] === b)
  );
}

/**
 * The file operations collection needs, kept narrow so tests can stand in
 * for iCloud Drive without touching the real filesystem.
 */
export interface DropFS {
  readdir(dir: string): Promise<string[]>;
  readFile(file: string): Promise<Uint8Array>;
  unlink(file: string): Promise<void>;
}

export interface CollectResult {
  collected: number;
  /** Files left in place this pass, to be tried again on the next. */
  deferred: string[];
}

/**
 * Moves every sealed blob out of the drop folder and into the inbox.
 *
 * The order is what makes this safe. The phone treats a file disappearing
 * from the drop folder as proof of delivery, so the source is only removed
 * once `store` has put the blob in the inbox; a failure anywhere before
 * that leaves the file for the next pass rather than losing the capture.
 *
 * A file that cannot be read, or does not start with the sealed magic, is
 * left alone rather than quarantined: iCloud can show a file before all of
 * it has arrived, so what looks malformed now may be whole a few seconds
 * later. Names other than `*.sealed`, including old-style `.icloud`
 * placeholders, are not ours to touch.
 *
 * A missing folder means nothing has been dropped yet, not a failure.
 */
export async function collectDrop(
  dir: string,
  fs: DropFS,
  store: (blob: Uint8Array) => Promise<void>,
): Promise<CollectResult> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { collected: 0, deferred: [] };
    }
    throw err;
  }
  const result: CollectResult = { collected: 0, deferred: [] };
  for (const name of names.filter((n) => n.endsWith(".sealed") && !n.startsWith(".")).sort()) {
    const file = path.join(dir, name);
    let blob: Uint8Array;
    try {
      blob = await fs.readFile(file);
    } catch {
      result.deferred.push(name);
      continue;
    }
    if (!isSealedBlob(blob)) {
      result.deferred.push(name);
      continue;
    }
    await store(blob);
    await fs.unlink(file);
    result.collected += 1;
  }
  return result;
}
