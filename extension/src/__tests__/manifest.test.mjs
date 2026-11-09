// Manifest and build checks. "every manifest path exists after build" assumes
// `npm run build` already ran (the plan's verify step is `npm run build && npm test`);
// it does not invoke the build itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifestPath = join(root, "manifest.json");
const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));

// Recursively list shipped files, skipping tests and dependencies.
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

test("manifest host_permissions are localhost-only", () => {
  const m = readManifest();
  assert.ok(Array.isArray(m.host_permissions) && m.host_permissions.length > 0);
  for (const origin of m.host_permissions) {
    assert.match(origin, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/\*$/, origin);
  }
});

test("manifest has no all-sites permission", () => {
  const raw = readFileSync(manifestPath, "utf8");
  assert.ok(!raw.includes("<all_urls>"), "<all_urls> must not appear");
  const m = readManifest();
  for (const p of [...(m.permissions ?? []), ...(m.host_permissions ?? [])]) {
    assert.ok(!/^\*:\/\/|^https?:\/\/\*\//.test(p), `all-sites pattern in required permissions: ${p}`);
  }
  assert.equal(m.content_scripts, undefined, "content scripts are injected on demand");
});

test("no remote script is referenced", () => {
  const files = [...walk(join(root, "src")), ...walk(join(root, "dist"))].filter((f) =>
    /\.(html|js|mjs)$/.test(f),
  );
  assert.ok(files.length > 0);
  const remoteScript = /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\//i;
  const remoteImport = /\bimport\s*(?:\(\s*|[^'";]*?\bfrom\s*)?["'](https?:)?\/\//;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    assert.ok(!remoteScript.test(text), `remote <script src> in ${f}`);
    assert.ok(!remoteImport.test(text), `remote import in ${f}`);
  }
});

test("every manifest path exists after build", () => {
  const m = readManifest();
  const paths = [
    m.background?.service_worker,
    m.options_page,
    ...Object.values(m.icons ?? {}),
    ...Object.values(m.action?.default_icon ?? {}),
    // Not named in the manifest but loaded at runtime by the service worker.
    "dist/content.js",
    "src/offscreen.html",
  ];
  for (const p of paths) {
    assert.equal(typeof p, "string", "manifest path missing");
    assert.ok(existsSync(join(root, p)), `missing: ${p} (run \`npm run build\` first)`);
  }
});

test("manifest requires Chrome 116 for runtime.getContexts", () => {
  assert.equal(readManifest().minimum_chrome_version, "116");
});
