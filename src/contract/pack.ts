import { zipSync, unzipSync } from "fflate";
import { Manifest, manifestKind, validateManifest } from "./manifest.js";

export const AUDIO_ENTRY = "audio.m4a";
export const TRANSCRIPT_ENTRY = "transcript.md";
export const MANIFEST_ENTRY = "manifest.json";

// Per-entry uncompressed size ceilings. The 64 MB body cap bounds only the
// sealed (compressed) blob; without these, a decrypted entry could inflate
// to gigabytes and exhaust memory (a zip bomb). fflate skips entries the
// filter rejects and errors if an entry inflates past its declared size,
// so both oversized and understated headers are contained.
const MAX_ENTRY_BYTES: Record<string, number> = {
  [MANIFEST_ENTRY]: 1 * 1024 * 1024,
  [TRANSCRIPT_ENTRY]: 10 * 1024 * 1024,
  [AUDIO_ENTRY]: 128 * 1024 * 1024,
};

export interface CapturePackage {
  manifest: Manifest;
  transcript: string;
  /** Present for voice captures, absent for link captures. */
  audio?: Uint8Array;
}

/**
 * Builds the plaintext zip package that gets sealed before leaving the
 * device: manifest.json and transcript.md always, plus audio.m4a for a
 * voice capture.
 */
export function buildPackage(pkg: CapturePackage): Uint8Array {
  validateManifest(pkg.manifest);
  const kind = manifestKind(pkg.manifest);
  if (kind === "voice" && pkg.audio === undefined) {
    throw new Error("package: a voice capture must carry audio");
  }
  if (kind !== "voice" && pkg.audio !== undefined) {
    throw new Error(`package: a ${kind} capture must not carry audio`);
  }
  const entries: Record<string, Uint8Array> = {
    [MANIFEST_ENTRY]: new TextEncoder().encode(
      JSON.stringify(pkg.manifest, null, 2),
    ),
    [TRANSCRIPT_ENTRY]: new TextEncoder().encode(pkg.transcript),
  };
  if (pkg.audio !== undefined) {
    entries[AUDIO_ENTRY] = pkg.audio;
  }
  return zipSync(entries, {
    level: 6,
    mtime: new Date(pkg.manifest.created_at),
  });
}

/**
 * Parses and validates a plaintext zip package, throwing if a required
 * entry is missing or the manifest is invalid. Which entries are required
 * follows the manifest kind: audio belongs to voice captures only.
 */
export function parsePackage(zipBytes: Uint8Array): CapturePackage {
  const entries = unzipSync(zipBytes, {
    filter: (file) => {
      const cap = MAX_ENTRY_BYTES[file.name];
      if (cap === undefined) return false;
      if (file.originalSize > cap) {
        throw new Error(`package: entry ${file.name} exceeds size limit`);
      }
      return true;
    },
  });
  for (const required of [MANIFEST_ENTRY, TRANSCRIPT_ENTRY]) {
    if (!(required in entries)) {
      throw new Error(`package: missing entry ${required}`);
    }
  }
  const manifest = validateManifest(
    JSON.parse(new TextDecoder().decode(entries[MANIFEST_ENTRY])),
  );
  const kind = manifestKind(manifest);
  const hasAudio = AUDIO_ENTRY in entries;
  if (kind === "voice" && !hasAudio) {
    throw new Error(`package: missing entry ${AUDIO_ENTRY}`);
  }
  if (kind !== "voice" && hasAudio) {
    throw new Error(`package: a ${kind} capture must not carry ${AUDIO_ENTRY}`);
  }
  return {
    manifest,
    transcript: new TextDecoder().decode(entries[TRANSCRIPT_ENTRY]),
    ...(hasAudio ? { audio: entries[AUDIO_ENTRY] } : {}),
  };
}

/**
 * Renders the transcript.md note body with Obsidian frontmatter and the
 * embedded audio link, matching the layout the vault expects.
 */
export function renderTranscriptNote(
  manifest: Manifest,
  transcriptText: string,
): string {
  const created = manifest.created_at.slice(0, 16);
  const tags = manifest.tags.join(", ");
  const kind = manifestKind(manifest);
  return [
    "---",
    `created: ${created}`,
    `source: ${kind}`,
    `capture_id: ${manifest.capture_id}`,
    `tags: [${tags}]`,
    "---",
    // Only a voice capture has an attachment to embed.
    ...(manifest.attachment_path ? [`![[${manifest.attachment_path}]]`] : []),
    "",
    transcriptText,
    "",
  ].join("\n");
}
