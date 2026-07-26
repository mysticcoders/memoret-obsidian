import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  buildPackage,
  renderTranscriptNote,
  generateKeypair,
  seal,
  type Manifest,
  type Keypair,
} from "../src/contract/index.js";
import { ingestSealedBlob, type VaultFS } from "../src/ingest.js";

class MemoryFS implements VaultFS {
  files = new Map<string, string | Uint8Array>();
  dirs = new Set<string>();

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }
  async mkdirp(dir: string): Promise<void> {
    this.dirs.add(dir);
  }
  async writeText(path: string, text: string): Promise<void> {
    this.files.set(path, text);
  }
  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }
}

function sampleManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    version: 1,
    capture_id: randomUUID(),
    created_at: "2026-07-22T14:30:00-07:00",
    device_id: "test-device",
    vault_note_path: "notes/2026-07-22-1430.md",
    attachment_path: "attachments/2026-07-22-1430.m4a",
    tags: ["voice", "capture"],
    duration_seconds: 92,
    transcript_model: "parakeet-v3",
    ...overrides,
  };
}

async function sealedBlobFor(
  kp: Keypair,
  manifest: Manifest,
  audio = new Uint8Array([1, 2, 3, 4]),
): Promise<Uint8Array> {
  const zip = buildPackage({
    manifest,
    transcript: renderTranscriptNote(manifest, "ingest test transcript"),
    audio,
  });
  return seal(zip, kp.publicKey);
}

describe("ingest core", () => {
  it("writes note and audio at manifest paths and reports them", async () => {
    const kp = await generateKeypair();
    const manifest = sampleManifest();
    const audio = new Uint8Array(2048).map((_, i) => (i * 7) % 256);
    const fs = new MemoryFS();
    const result = await ingestSealedBlob(
      await sealedBlobFor(kp, manifest, audio),
      kp,
      fs,
      new Set(),
    );
    expect(result.duplicate).toBe(false);
    expect(result.notePath).toBe(manifest.vault_note_path);
    expect(result.audioPath).toBe(manifest.attachment_path);
    expect(fs.dirs).toContain("notes");
    expect(fs.dirs).toContain("attachments");
    expect(fs.files.get(manifest.attachment_path!)).toEqual(audio);
    expect(fs.files.get(manifest.vault_note_path)).toContain(
      manifest.capture_id,
    );
  });

  it("skips a capture id that was already ingested", async () => {
    const kp = await generateKeypair();
    const manifest = sampleManifest();
    const fs = new MemoryFS();
    const result = await ingestSealedBlob(
      await sealedBlobFor(kp, manifest),
      kp,
      fs,
      new Set([manifest.capture_id]),
    );
    expect(result.duplicate).toBe(true);
    expect(fs.files.size).toBe(0);
  });

  it("suffixes destination paths that already exist", async () => {
    const kp = await generateKeypair();
    const manifest = sampleManifest();
    const fs = new MemoryFS();
    fs.files.set(manifest.vault_note_path, "pre-existing note");
    const result = await ingestSealedBlob(
      await sealedBlobFor(kp, manifest),
      kp,
      fs,
      new Set(),
    );
    const short = manifest.capture_id.slice(0, 8);
    expect(result.notePath).toBe(`notes/2026-07-22-1430-${short}.md`);
    expect(fs.files.get(manifest.vault_note_path)).toBe("pre-existing note");
    expect(result.audioPath).toBe(manifest.attachment_path);
  });

  it("throws on a blob sealed to a different keypair", async () => {
    const kp = await generateKeypair();
    const other = await generateKeypair();
    const blob = await sealedBlobFor(other, sampleManifest());
    await expect(
      ingestSealedBlob(blob, kp, new MemoryFS(), new Set()),
    ).rejects.toThrow(/decryption failed/);
  });

  it("writes nothing when decryption fails", async () => {
    const kp = await generateKeypair();
    const blob = await sealedBlobFor(kp, sampleManifest());
    blob[blob.length - 1] ^= 0xff;
    const fs = new MemoryFS();
    await expect(
      ingestSealedBlob(blob, kp, fs, new Set()),
    ).rejects.toThrow();
    expect(fs.files.size).toBe(0);
    expect(fs.dirs.size).toBe(0);
  });
});

describe("link captures", () => {
  it("writes the note and no attachment", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    const manifest: Manifest = {
      version: 1,
      capture_id: randomUUID(),
      created_at: "2026-07-26T09:15:00-07:00",
      device_id: "iphone",
      vault_note_path: "notes/2026-07-26-0915.md",
      tags: ["link"],
      kind: "link",
    };
    const transcript = renderTranscriptNote(manifest, "https://example.com/watch");
    const blob = await seal(buildPackage({ manifest, transcript }), kp.publicKey);

    const result = await ingestSealedBlob(blob, kp, fs, new Set());

    expect(result.duplicate).toBe(false);
    expect(result.notePath).toBe(manifest.vault_note_path);
    expect(result.audioPath).toBeUndefined();
    expect(fs.dirs).toContain("notes");
    expect(fs.dirs).not.toContain("attachments");
    expect(fs.files.size).toBe(1);
    expect(fs.files.get(manifest.vault_note_path)).toContain(
      "https://example.com/watch",
    );
  });
});
