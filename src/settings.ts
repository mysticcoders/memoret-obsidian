import type { DateSubfolders } from "./ingest.js";

export interface MemoretSettings {
  /** Vault folder notes land in; empty means the vault root. */
  noteFolder: string;
  /** Vault folder audio attachments land in. */
  attachmentFolder: string;
  dateSubfolders: DateSubfolders;
  /** Whether the LAN receiver binds and advertises itself at all. */
  lanEnabled: boolean;
  lanPort: number;
  scanIntervalSeconds: number;
  /** Whether captures the phone leaves in iCloud Drive are collected. macOS only. */
  icloudCollect: boolean;
}

/**
 * Defaults chosen to match what the iOS app already puts in its manifests,
 * so an existing vault sees no change in where its captures land when it
 * upgrades into having settings.
 */
export const DEFAULT_SETTINGS: MemoretSettings = {
  noteFolder: "notes",
  attachmentFolder: "attachments",
  dateSubfolders: "none",
  lanEnabled: true,
  lanPort: 41830,
  scanIntervalSeconds: 15,
  icloudCollect: true,
};

/**
 * Reduces a typed folder to something safe to write inside the vault.
 *
 * Traversal segments and dot-directories are dropped rather than rejected:
 * a typo in a text field should not be able to write outside the vault or
 * into Obsidian's own hidden folders, and silently landing in a sane place
 * beats refusing to save.
 */
export function sanitizeFolder(value: string): string {
  return value
    .split("/")
    .map((segment) => segment.trim())
    .filter(
      (segment) =>
        segment.length > 0 &&
        segment !== "." &&
        segment !== ".." &&
        !segment.startsWith("."),
    )
    .join("/");
}

/**
 * Clamps a number that arrived from a text field, falling back to the
 * default when it is not a number at all.
 */
export function clampNumber(
  raw: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
