export const MANIFEST_VERSION = 1;

/**
 * What a capture carries. "voice" is a recording with audio; "link" is a
 * URL shared from elsewhere and has no audio of its own.
 *
 * The field is optional and absent means "voice", so every capture written
 * before this existed stays valid. The version stays at 1 for the same
 * reason: bumping it would make older receivers reject voice captures they
 * handle perfectly well. Receivers advertise which kinds they accept on
 * /ping instead, and senders check before delivering.
 */
export type CaptureKind = "voice" | "link";

export const CAPTURE_KINDS: readonly CaptureKind[] = ["voice", "link"];

export interface Manifest {
  version: number;
  capture_id: string;
  created_at: string;
  device_id: string;
  vault_note_path: string;
  tags: string[];
  kind?: CaptureKind;
  /** Required for voice captures, absent for link captures. */
  attachment_path?: string;
  /** Required for voice captures, absent for link captures. */
  duration_seconds?: number;
  /** Required for voice captures, absent for link captures. */
  transcript_model?: string;
}

/**
 * The kind a manifest declares, treating absence as "voice".
 */
export function manifestKind(manifest: Manifest): CaptureKind {
  return manifest.kind ?? "voice";
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
  if (typeof m.vault_note_path !== "string" || !isSafeVaultPath(m.vault_note_path)) {
    throw new Error("manifest: vault_note_path is not a safe vault-relative path");
  }
  if (
    !Array.isArray(m.tags) ||
    !m.tags.every((t) => typeof t === "string" && t.length > 0)
  ) {
    throw new Error("manifest: tags must be an array of non-empty strings");
  }
  if (m.kind !== undefined && !CAPTURE_KINDS.includes(m.kind as CaptureKind)) {
    throw new Error(`manifest: unsupported kind ${String(m.kind)}`);
  }
  const kind: CaptureKind = (m.kind as CaptureKind) ?? "voice";

  // The audio-bearing fields travel together: a voice capture must carry all
  // of them, a link capture none. Allowing a half-populated manifest would
  // leave receivers guessing whether to expect an audio entry.
  if (kind === "voice") {
    if (typeof m.attachment_path !== "string" || !isSafeVaultPath(m.attachment_path)) {
      throw new Error("manifest: attachment_path is not a safe vault-relative path");
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
  } else {
    for (const field of ["attachment_path", "duration_seconds", "transcript_model"] as const) {
      if (m[field] !== undefined) {
        throw new Error(`manifest: ${field} is not allowed on a ${kind} capture`);
      }
    }
  }
  return m as unknown as Manifest;
}
