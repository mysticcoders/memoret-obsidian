import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const production = process.argv[2] === "production";

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
  logLevel: "info",
});

mkdirSync("dist", { recursive: true });
copyFileSync("manifest.json", "dist/manifest.json");
