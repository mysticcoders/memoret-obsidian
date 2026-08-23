import esbuild from "esbuild";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";

const production = process.argv[2] === "production";

/**
 * Strips `.unref()` calls out of bundled dependencies.
 *
 * A plugin runs in Obsidian's renderer, where `setTimeout` is the DOM one and
 * returns a number rather than a Node `Timeout`. bonjour-service calls
 * `.unref()` on its probe and re-announce timers, which throws there — the
 * timer is already scheduled by then, so mDNS keeps working, but every
 * announcement leaves an uncaught TypeError in the console and abandons the
 * rest of the callback it was in.
 *
 * Dropping the call is safe: `unref()` only tells Node not to hold the
 * process open for a pending timer, and a renderer has no such lifetime to
 * hold open.
 */
const stripUnref = {
  name: "strip-unref",
  setup(build) {
    build.onLoad({ filter: /bonjour-service[\\/].*\.js$/ }, (args) => ({
      contents: readFileSync(args.path, "utf8").replaceAll(".unref()", ""),
      loader: "js",
    }));
  },
};

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron"],
  format: "cjs",
  platform: "node",
  target: "es2022",
  outfile: "dist/main.js",
  sourcemap: production ? false : "inline",
  treeShaking: true,
  plugins: [stripUnref],
  logLevel: "info",
});

// The invariant, checked against what actually ships rather than against the
// dependency's current source: a call left in here is a crash in the console
// on every announcement, and it would arrive silently through an upgrade.
// Production only — a dev build inlines a source map, whose copy of the
// sources would match this text without shipping anywhere.
if (production && readFileSync("dist/main.js", "utf8").includes(".unref(")) {
  throw new Error(
    "dist/main.js still calls .unref() — it will throw in Obsidian's renderer",
  );
}

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
