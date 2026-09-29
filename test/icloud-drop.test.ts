import { describe, expect, it } from "vitest";
import * as path from "node:path";

import { SEALED_MAGIC } from "../src/contract/index.js";
import { collectDrop, dropFolder, isSealedBlob, type DropFS } from "../src/icloud-drop.js";

const DIR = "/drop/9415d7ac78c2f917";

function sealed(tag: number): Uint8Array {
  return new Uint8Array([...SEALED_MAGIC, tag, tag, tag]);
}

/**
 * An in-memory drop folder. Files named in `unreadable` throw on read, the
 * way a file iCloud has not finished downloading can.
 */
function fakeDrop(
  files: Record<string, Uint8Array>,
  unreadable: string[] = [],
): DropFS & { files: Record<string, Uint8Array>; log: string[] } {
  const log: string[] = [];
  return {
    files,
    log,
    async readdir(dir) {
      if (dir !== DIR) {
        throw Object.assign(new Error("no such directory"), { code: "ENOENT" });
      }
      return Object.keys(files);
    },
    async readFile(file) {
      const name = path.basename(file);
      if (unreadable.includes(name)) throw new Error("resource busy");
      return files[name];
    },
    async unlink(file) {
      log.push(`unlink ${path.basename(file)}`);
      delete files[path.basename(file)];
    },
  };
}

describe("drop folder", () => {
  it("is the fingerprint's own folder inside the iOS app's container", () => {
    expect(dropFolder("/Users/someone", "9415d7ac78c2f917")).toBe(
      "/Users/someone/Library/Mobile Documents/iCloud~com~mysticcoders~memoret/Documents/drop/9415d7ac78c2f917",
    );
  });
});

describe("collecting from iCloud Drive", () => {
  it("moves each sealed blob into the inbox and removes it from the drop", async () => {
    const drop = fakeDrop({ "a.sealed": sealed(1), "b.sealed": sealed(2) });
    const stored: Uint8Array[] = [];
    const result = await collectDrop(DIR, drop, async (blob) => {
      stored.push(blob);
    });
    expect(result).toEqual({ collected: 2, deferred: [] });
    expect(stored).toEqual([sealed(1), sealed(2)]);
    expect(drop.files).toEqual({});
  });

  // The phone reads the file vanishing as proof of delivery. Removing it
  // before the inbox write lands would tell the phone a capture arrived
  // that the vault never received.
  it("removes the source only after the inbox write succeeds", async () => {
    const drop = fakeDrop({ "a.sealed": sealed(1) });
    await expect(
      collectDrop(DIR, drop, async () => {
        throw new Error("vault is read-only");
      }),
    ).rejects.toThrow("vault is read-only");
    expect(drop.log).toEqual([]);
    expect(Object.keys(drop.files)).toEqual(["a.sealed"]);
  });

  it("stores before it unlinks", async () => {
    const drop = fakeDrop({ "a.sealed": sealed(1) });
    await collectDrop(DIR, drop, async () => {
      drop.log.push("store");
    });
    expect(drop.log).toEqual(["store", "unlink a.sealed"]);
  });

  // iCloud can list a file before all of it has arrived. Quarantining what
  // is merely incomplete would lose a capture that is fine a moment later.
  it("leaves an unreadable or partial file for the next pass", async () => {
    const drop = fakeDrop(
      {
        "busy.sealed": sealed(1),
        "partial.sealed": new Uint8Array([SEALED_MAGIC[0]]),
        "good.sealed": sealed(3),
      },
      ["busy.sealed"],
    );
    const result = await collectDrop(DIR, drop, async () => {});
    expect(result.collected).toBe(1);
    expect(result.deferred.sort()).toEqual(["busy.sealed", "partial.sealed"]);
    expect(Object.keys(drop.files).sort()).toEqual(["busy.sealed", "partial.sealed"]);
  });

  it("ignores anything that is not a sealed capture", async () => {
    const drop = fakeDrop({
      ".a.sealed.icloud": sealed(1),
      "notes.txt": sealed(2),
      ".hidden.sealed": sealed(3),
    });
    const result = await collectDrop(DIR, drop, async () => {});
    expect(result).toEqual({ collected: 0, deferred: [] });
    expect(Object.keys(drop.files).length).toBe(3);
  });

  it("treats a folder that does not exist yet as empty", async () => {
    const drop = fakeDrop({});
    await expect(collectDrop("/elsewhere", drop, async () => {})).resolves.toEqual({
      collected: 0,
      deferred: [],
    });
  });
});

describe("sealed blob check", () => {
  it("accepts the magic and refuses anything shorter or different", () => {
    expect(isSealedBlob(sealed(0))).toBe(true);
    expect(isSealedBlob(new Uint8Array(SEALED_MAGIC))).toBe(true);
    expect(isSealedBlob(new Uint8Array(SEALED_MAGIC.slice(0, -1)))).toBe(false);
    expect(isSealedBlob(new Uint8Array([0, 1, 2, 3, 4, 5]))).toBe(false);
  });
});
