export const MANIFEST_VERSION = 1;

export interface Manifest {
  version: number;
  capture_id: string;
  created_at: string;
  device_id: string;
  vault_note_path: string;
  attachment_path: string;
  tags: string[];
  duration_seconds: number;
  transcript_model: string;
}

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Rejects vault-relative paths that could escape the vault or collide with
 * hidden Obsidian internals when written by the ingesting plugin.
 */
export function isSafeVaultPath(p: string): boolean {
  if (p.length === 0 || p.startsWith("/") || p.includes("\\")) return false;
  const segments = p.split("/");
  return segments.every(
    (s) => s.length > 0 && s !== "." && s !== ".." && !s.startsWith("."),
  );
}

/**
 * Validates a parsed manifest object and returns it typed, throwing a
 * descriptive error on the first violation found.
 */
export function validateManifest(raw: unknown): Manifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("manifest: not an object");
  }
  const m = raw as Record<string, unknown>;
  if (m.version !== MANIFEST_VERSION) {
    throw new Error(`manifest: unsupported version ${String(m.version)}`);
  }
  if (typeof m.capture_id !== "string" || !UUID_V4.test(m.capture_id)) {
    throw new Error("manifest: capture_id must be a UUID v4");
  }
  if (
    typeof m.created_at !== "string" ||
    Number.isNaN(Date.parse(m.created_at))
  ) {
    throw new Error("manifest: created_at must be an ISO-8601 timestamp");
  }
  if (typeof m.device_id !== "string" || m.device_id.length === 0) {
    throw new Error("manifest: device_id must be a non-empty string");
  }
  for (const field of ["vault_note_path", "attachment_path"] as const) {
    const value = m[field];
    if (typeof value !== "string" || !isSafeVaultPath(value)) {
      throw new Error(`manifest: ${field} is not a safe vault-relative path`);
    }
  }
  if (
    !Array.isArray(m.tags) ||
    !m.tags.every((t) => typeof t === "string" && t.length > 0)
  ) {
    throw new Error("manifest: tags must be an array of non-empty strings");
  }
  if (
    typeof m.duration_seconds !== "number" ||
    !Number.isFinite(m.duration_seconds) ||
    m.duration_seconds < 0
  ) {
    throw new Error("manifest: duration_seconds must be a non-negative number");
  }
  if (typeof m.transcript_model !== "string" || m.transcript_model.length === 0) {
    throw new Error("manifest: transcript_model must be a non-empty string");
  }
  return m as unknown as Manifest;
}
