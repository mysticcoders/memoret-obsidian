import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validateManifest } from "../src/contract/manifest.js";

/**
 * The shared corpus this receiver is measured against.
 *
 * The corpus lives in its own public repository so every implementation
 * reads one copy rather than keeping its own to drift. Fetch it with
 * `npm run fixtures`; CI does that before the suite.
 *
 * A missing corpus fails loudly rather than skipping: a conformance suite
 * that quietly runs nothing is worse than none, because it reads as
 * agreement.
 */
interface Corpus {
  corpusVersion: number;
  cases: {
    name: string;
    accept: boolean;
    reason?: string;
    manifest: unknown;
  }[];
}

const path = fileURLToPath(new URL("../fixtures/manifests.json", import.meta.url));
if (!existsSync(path)) {
  throw new Error(
    `conformance corpus missing at ${path}. Run 'npm run fixtures' to download it.`,
  );
}
const corpus = JSON.parse(readFileSync(path, "utf8")) as Corpus;

describe(`manifest corpus v${String(corpus.corpusVersion)}`, () => {
  it("is not empty, so a mis-resolved path cannot pass as agreement", () => {
    expect(corpus.cases.length).toBeGreaterThan(10);
  });

  for (const testCase of corpus.cases) {
    it(`${testCase.accept ? "accepts" : "rejects"} ${testCase.name}`, () => {
      if (testCase.accept) {
        expect(() => validateManifest(testCase.manifest)).not.toThrow();
        return;
      }
      let thrown: unknown;
      try {
        validateManifest(testCase.manifest);
      } catch (err) {
        thrown = err;
      }
      expect(thrown, "expected this manifest to be rejected").toBeInstanceOf(Error);
      const reason = testCase.reason;
      if (reason !== undefined) {
        // Matched on a manifest field name rather than on wording: field
        // names are JSON keys and identical everywhere, sentences are not.
        expect((thrown as Error).message).toContain(
          reason === "audio_fields" ? "attachment_path" : reason,
        );
      }
    });
  }
});
