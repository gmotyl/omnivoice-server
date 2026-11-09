// Bundles the content script into dist/content.js (injected on demand by the service worker).
import { build } from "esbuild";

await build({
  entryPoints: ["src/content/main.mjs"],
  outfile: "dist/content.js",
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  logLevel: "info",
});
