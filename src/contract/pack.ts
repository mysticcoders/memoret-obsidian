import { zipSync, unzipSync } from "fflate";
import { Manifest, validateManifest } from "./manifest.js";

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
  audio: Uint8Array;
}

/**
 * Builds the plaintext zip package (manifest.json + transcript.md +
 * audio.m4a) that gets sealed before leaving the device.
 */
export function buildPackage(pkg: CapturePackage): Uint8Array {
  validateManifest(pkg.manifest);
  return zipSync(
    {
      [MANIFEST_ENTRY]: new TextEncoder().encode(
        JSON.stringify(pkg.manifest, null, 2),
      ),
      [TRANSCRIPT_ENTRY]: new TextEncoder().encode(pkg.transcript),
      [AUDIO_ENTRY]: pkg.audio,
    },
    { level: 6, mtime: new Date(pkg.manifest.created_at) },
  );
}

/**
 * Parses and validates a plaintext zip package, throwing if any of the
 * three required entries is missing or the manifest is invalid.
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
  for (const required of [MANIFEST_ENTRY, TRANSCRIPT_ENTRY, AUDIO_ENTRY]) {
    if (!(required in entries)) {
      throw new Error(`package: missing entry ${required}`);
    }
  }
  const manifest = validateManifest(
    JSON.parse(new TextDecoder().decode(entries[MANIFEST_ENTRY])),
  );
  return {
    manifest,
    transcript: new TextDecoder().decode(entries[TRANSCRIPT_ENTRY]),
    audio: entries[AUDIO_ENTRY],
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
  return [
    "---",
    `created: ${created}`,
    "source: voice",
    `capture_id: ${manifest.capture_id}`,
    `tags: [${tags}]`,
    "---",
    `![[${manifest.attachment_path}]]`,
    "",
    transcriptText,
    "",
  ].join("\n");
}
