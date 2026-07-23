import { zipSync, unzipSync } from "fflate";
import { Manifest, validateManifest } from "./manifest.js";

export const AUDIO_ENTRY = "audio.m4a";
export const TRANSCRIPT_ENTRY = "transcript.md";
export const MANIFEST_ENTRY = "manifest.json";

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
  const entries = unzipSync(zipBytes);
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
