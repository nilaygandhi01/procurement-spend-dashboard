/**
 * Regenerate src/dashboard/Cummins_IDP_Dashboard.html from
 * src/dashboard/index.html, inlining harmonization-client.js so the
 * file is self-contained and can be served from a static file server
 * (python -m http.server etc) without needing the sibling JS file.
 *
 * The replacement is idempotent: running it twice produces the same
 * output. Tailwind's Play CDN script tag is preserved (already part
 * of index.html).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const srcDir = path.join(repoRoot, "src", "dashboard");

const indexHtmlPath = path.join(srcDir, "index.html");
const harmJsPath = path.join(srcDir, "harmonization-client.js");
const outPath = path.join(srcDir, "Cummins_IDP_Dashboard.html");

const html = fs.readFileSync(indexHtmlPath, "utf8");
const js = fs.readFileSync(harmJsPath, "utf8");

const scriptTagRegex = /<script\s+src=["']harmonization-client\.js["']\s*><\/script>/;
if (!scriptTagRegex.test(html)) {
  console.error("FAIL: <script src=harmonization-client.js> tag not found in index.html");
  process.exit(2);
}

const inlined = `<script>\n/* INLINED from harmonization-client.js by scripts/regen-local-dashboard.mjs */\n${js}\n</script>`;
/* Pass a function callback so `$&`, `$1`, etc inside the JS source
   (e.g. /[-/\\^$*+?.()|[\]{}]/g replace patterns) are NOT interpreted
   as special replacement tokens. */
const out = html.replace(scriptTagRegex, () => inlined);

fs.writeFileSync(outPath, out, "utf8");
console.log(`OK: wrote ${path.relative(repoRoot, outPath)} (${out.length.toLocaleString()} bytes)`);
