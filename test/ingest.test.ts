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
import {
  ingestSealedBlob,
  placeInFolder,
  rememberedIds,
  rewriteAudioEmbed,
  type VaultFS,
} from "../src/ingest.js";
import { clampNumber, sanitizeFolder } from "../src/settings.js";

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
  async remove(path: string): Promise<void> {
    this.files.delete(path);
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
    // The whole capture id, not a prefix of it: a suffix that collides in
    // turn is what the truncated form made likelier.
    expect(result.notePath).toBe(`notes/2026-07-22-1430-${manifest.capture_id}.md`);
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

describe("placement", () => {
  it("keeps the manifest path when no folder is configured", () => {
    expect(placeInFolder("notes/2026-07-22-1430.md", undefined, "2026-07-22T14:30:00Z")).toBe(
      "notes/2026-07-22-1430.md",
    );
  });

  it("moves a capture into the configured folder, keeping its filename", () => {
    expect(
      placeInFolder("notes/2026-07-22-1430.md", "Captures/Voice", "2026-07-22T14:30:00Z"),
    ).toBe("Captures/Voice/2026-07-22-1430.md");
  });

  it("writes to the vault root when the folder is empty", () => {
    expect(placeInFolder("notes/x.md", "", "2026-07-22T14:30:00Z")).toBe("x.md");
  });

  it("nests by year and month, or by day", () => {
    expect(placeInFolder("notes/x.md", "Captures", "2026-07-22T14:30:00Z", "month")).toBe(
      "Captures/2026/07/x.md",
    );
    expect(placeInFolder("notes/x.md", "Captures", "2026-07-22T14:30:00Z", "day")).toBe(
      "Captures/2026/07/22/x.md",
    );
  });

  it("flattens rather than inventing folders when the timestamp is malformed", () => {
    expect(placeInFolder("notes/x.md", "Captures", "not-a-date", "day")).toBe(
      "Captures/x.md",
    );
  });

  it("takes only the filename, so a sender cannot steer the destination", () => {
    expect(placeInFolder("a/b/c/deep.md", "Captures", "2026-07-22T14:30:00Z")).toBe(
      "Captures/deep.md",
    );
  });

  it("routes an ingested capture through the configured folders", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    const manifest = sampleManifest();
    const blob = await sealedBlobFor(kp, manifest);
    const result = await ingestSealedBlob(blob, kp, fs, new Set(), {
      noteFolder: "Inbox/Memoret",
      attachmentFolder: "Inbox/Memoret/audio",
      dateSubfolders: "month",
    });
    expect(result.notePath).toBe("Inbox/Memoret/2026/07/2026-07-22-1430.md");
    expect(result.audioPath).toBe("Inbox/Memoret/audio/2026/07/2026-07-22-1430.m4a");
    expect(fs.files.has(result.notePath!)).toBe(true);
    expect(fs.files.has(result.audioPath!)).toBe(true);
  });
});

describe("folder sanitising", () => {
  it("strips traversal and hidden segments", () => {
    expect(sanitizeFolder("../../etc")).toBe("etc");
    expect(sanitizeFolder("Captures/../.obsidian")).toBe("Captures");
    expect(sanitizeFolder("  Notes / Voice  ")).toBe("Notes/Voice");
    expect(sanitizeFolder("")).toBe("");
  });

  it("clamps numbers from text fields and falls back on nonsense", () => {
    expect(clampNumber("70000", 41830, 1024, 65535)).toBe(65535);
    expect(clampNumber("80", 41830, 1024, 65535)).toBe(1024);
    expect(clampNumber("banana", 41830, 1024, 65535)).toBe(41830);
    expect(clampNumber("8080", 41830, 1024, 65535)).toBe(8080);
  });
});

describe("audio embed follows the attachment", () => {
  it("rewrites the embed when placement moves the attachment", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    const manifest = sampleManifest();
    const blob = await sealedBlobFor(kp, manifest);
    const result = await ingestSealedBlob(blob, kp, fs, new Set(), {
      noteFolder: "Captures",
      attachmentFolder: "Captures/audio",
      dateSubfolders: "month",
    });
    const note = fs.files.get(result.notePath!) as string;
    expect(result.audioPath).toBe("Captures/audio/2026/07/2026-07-22-1430.m4a");
    expect(note).toContain(`![[${result.audioPath!}]]`);
    expect(note).not.toContain("![[attachments/2026-07-22-1430.m4a]]");
  });

  it("rewrites the embed when a collision renames the attachment", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    const manifest = sampleManifest();
    await fs.writeBinary("attachments/2026-07-22-1430.m4a", new Uint8Array([9]));
    const blob = await sealedBlobFor(kp, manifest);
    const result = await ingestSealedBlob(blob, kp, fs, new Set());
    expect(result.audioPath).not.toBe("attachments/2026-07-22-1430.m4a");
    const note = fs.files.get(result.notePath!) as string;
    expect(note).toContain(`![[${result.audioPath!}]]`);
  });

  it("leaves a link capture's note alone", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    const manifest = sampleManifest({
      kind: "link",
      attachment_path: undefined,
      duration_seconds: undefined,
      transcript_model: undefined,
    });
    const zip = buildPackage({
      manifest,
      transcript: renderTranscriptNote(manifest, "https://example.com/x"),
    });
    const result = await ingestSealedBlob(await seal(zip, kp.publicKey), kp, fs, new Set(), {
      noteFolder: "Captures",
    });
    expect(result.audioPath).toBeUndefined();
    expect(fs.files.get(result.notePath!) as string).toContain("https://example.com/x");
  });

  it("does not touch an identical line elsewhere in the transcript", () => {
    const note = [
      "---",
      "created: 2026-07-22T14:30",
      "---",
      "![[attachments/a.m4a]]",
      "",
      "I wrote ![[attachments/a.m4a]] in my notes",
      "![[attachments/a.m4a]]",
    ].join("\n");
    const out = rewriteAudioEmbed(note, "attachments/a.m4a", "Audio/a.m4a");
    expect(out.split("\n")[3]).toBe("![[Audio/a.m4a]]");
    expect(out).toContain("I wrote ![[attachments/a.m4a]] in my notes");
    expect(out.split("\n")[6]).toBe("![[attachments/a.m4a]]");
  });
});

describe("collision resolution is exhaustive", () => {
  it("keeps looking past an occupied suffixed name", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    const manifest = sampleManifest();
    const id = manifest.capture_id;
    await fs.writeText("notes/2026-07-22-1430.md", "taken");
    await fs.writeText(`notes/2026-07-22-1430-${id}.md`, "also taken");
    await fs.writeBinary("attachments/2026-07-22-1430.m4a", new Uint8Array([9]));
    await fs.writeBinary(`attachments/2026-07-22-1430-${id}.m4a`, new Uint8Array([9]));
    const result = await ingestSealedBlob(await sealedBlobFor(kp, manifest), kp, fs, new Set());
    expect(result.notePath).toBe(`notes/2026-07-22-1430-${id}-2.md`);
    expect(result.audioPath).toBe(`attachments/2026-07-22-1430-${id}-2.m4a`);
    expect(fs.files.get("notes/2026-07-22-1430.md")).toBe("taken");
    expect(fs.files.get(`notes/2026-07-22-1430-${id}.md`)).toBe("also taken");
  });
});

describe("a failed write leaves nothing behind", () => {
  it("removes the audio when the note cannot be written", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    fs.writeText = async () => {
      throw new Error("disk full");
    };
    const manifest = sampleManifest();
    await expect(
      ingestSealedBlob(await sealedBlobFor(kp, manifest), kp, fs, new Set()),
    ).rejects.toThrow("disk full");
    // The recording must not survive the note that was to refer to it.
    expect(fs.files.has(manifest.attachment_path!)).toBe(false);
  });

  it("still reports the original failure when cleanup also fails", async () => {
    const kp = await generateKeypair();
    const fs = new MemoryFS();
    fs.writeText = async () => {
      throw new Error("disk full");
    };
    fs.remove = async () => {
      throw new Error("read-only vault");
    };
    await expect(
      ingestSealedBlob(await sealedBlobFor(kp, sampleManifest()), kp, fs, new Set()),
    ).rejects.toThrow("disk full");
  });
});

describe("dedupe index is bounded", () => {
  it("keeps everything until the cap", () => {
    const ids = new Set(Array.from({ length: 100 }, (_, i) => `id-${String(i)}`));
    expect(rememberedIds(ids)).toHaveLength(100);
  });

  it("forgets the oldest, keeping the newest", () => {
    // The cap is large, so this builds past it rather than assuming it.
    const total = 50_000 + 5;
    const ids = new Set(Array.from({ length: total }, (_, i) => `id-${String(i)}`));
    const kept = rememberedIds(ids);
    expect(kept).toHaveLength(50_000);
    expect(kept.at(-1)).toBe(`id-${String(total - 1)}`);
    expect(kept[0]).toBe("id-5");
    expect(kept).not.toContain("id-0");
  });
});
