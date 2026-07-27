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
 * A date and a time with an offset — RFC 3339, which is what every sender
 * emits.
 *
 * This used to be `Date.parse`, which took "March 5, 2026" and "2026" and
 * a bare date, none of which name a moment. The Swift receiver rejected
 * all of them, so the three implementations disagreed about what a valid
 * capture was; see the shared corpus at
 * github.com/mysticcoders/memoret-contract-fixtures. The offset is
 * required because a local time is ambiguous and nothing downstream can
 * recover which one was meant.
 *
 * The shape is checked first and the value second: a regex alone would
 * admit 2026-02-30.
 */
const RFC3339 =
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function isTimestamp(value: string): boolean {
  if (!RFC3339.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return false;
  // The components are compared in UTC and never converted, because the
  // offset can legitimately put a capture on a different UTC day than the
  // one it names — an evening in California is already tomorrow in London.
  // Date.UTC rolls an out-of-range day forward, so reading it back is what
  // catches February 30th.
  const rolled = new Date(Date.UTC(year, month - 1, day));
  if (rolled.getUTCMonth() !== month - 1 || rolled.getUTCDate() !== day) {
    return false;
  }
  return (
    Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60
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
    !isTimestamp(m.created_at)
  ) {
    throw new Error("manifest: created_at must be an RFC 3339 timestamp");
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
    // Absence and unsafety are reported apart. Telling someone their
    // attachment_path is unsafe when they never sent one points at path
    // validation instead of at the missing field.
    for (const field of ["attachment_path", "duration_seconds", "transcript_model"] as const) {
      if (m[field] === undefined) {
        throw new Error(`manifest: a voice capture must carry ${field}`);
      }
    }
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
