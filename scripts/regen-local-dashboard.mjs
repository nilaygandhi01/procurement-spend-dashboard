/**
 * Regenerate src/dashboard/Cummins_IDP_Dashboard.html from
 * src/dashboard/index.html, producing a single self-contained HTML
 * file that can be opened directly from disk (file:// URL) or served
 * from any static file server with NO sibling assets — no network,
 * no /tailwind.css fetch, no harmonization-client.js fetch.
 *
 * Three inlining passes:
 *   1) harmonization-client.js -> inline <script> block
 *   2) Compiled Tailwind utilities -> inline <style> block.
 *      Uses the same Tailwind v3 standalone CLI as the Docker
 *      `tailwind-build` stage, scanning the same content paths, so
 *      the inlined CSS matches what nginx serves in production.
 *   3) Cached Tailwind output reused across runs so iterating on the
 *      dashboard locally doesn't pay the ~10-15s Tailwind compile
 *      cost every time. The cache key is the SHA-256 of the inputs
 *      Tailwind scans (index.html, harmonization-client.js, the
 *      Tailwind config, the input CSS).
 *
 * The replacement is idempotent: running it twice produces the same
 * output.
 *
 * Run:
 *   node --max-old-space-size=8192 scripts/regen-local-dashboard.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const srcDir = path.join(repoRoot, "src", "dashboard");
const deployTailwindDir = path.join(repoRoot, "deploy", "tailwind");

const indexHtmlPath = path.join(srcDir, "index.html");
const harmJsPath = path.join(srcDir, "harmonization-client.js");
const tailwindConfigPath = path.join(deployTailwindDir, "tailwind.config.js");
const tailwindInputCssPath = path.join(deployTailwindDir, "input.css");
const outPath = path.join(srcDir, "Cummins_IDP_Dashboard.html");

const html = fs.readFileSync(indexHtmlPath, "utf8");
const js = fs.readFileSync(harmJsPath, "utf8");

/* ---- Pass 1: inline harmonization-client.js ---------------------------- */
const scriptTagRegex = /<script\s+src=["']harmonization-client\.js["']\s*><\/script>/;
if (!scriptTagRegex.test(html)) {
  console.error("FAIL: <script src=harmonization-client.js> tag not found in index.html");
  process.exit(2);
}
const inlinedJs = `<script>\n/* INLINED from harmonization-client.js by scripts/regen-local-dashboard.mjs */\n${js}\n</script>`;
/* Pass a function callback so `$&`, `$1`, etc inside the JS source
   (e.g. /[-/\\^$*+?.()|[\]{}]/g replace patterns) are NOT interpreted
   as special replacement tokens. */
let out = html.replace(scriptTagRegex, () => inlinedJs);

/* ---- Pass 2: compile + inline Tailwind utilities ----------------------- */
function sha256(s) { return crypto.createHash("sha256").update(s).digest("hex"); }
const tailwindConfigSrc = fs.readFileSync(tailwindConfigPath, "utf8");
const tailwindInputSrc = fs.readFileSync(tailwindInputCssPath, "utf8");
const cacheKey = sha256(html + "\u0000" + js + "\u0000" + tailwindConfigSrc + "\u0000" + tailwindInputSrc);
const cacheDir = path.join(repoRoot, ".cache");
if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });
const cssCachePath = path.join(cacheDir, "tailwind-" + cacheKey.slice(0, 16) + ".css");
let twCss = "";
if (fs.existsSync(cssCachePath)) {
  twCss = fs.readFileSync(cssCachePath, "utf8");
  console.log("Tailwind cache hit (" + (twCss.length / 1024).toFixed(1) + " KB) at " + path.relative(repoRoot, cssCachePath));
} else {
  console.log("Tailwind cache miss — compiling via Tailwind CLI (one-time, ~10-15s)…");
  const tmpOut = path.join(os.tmpdir(), "regen-tailwind-" + Date.now() + ".css");
  /* Tailwind v3.4.17 — same version pinned by the Dockerfile's
     tailwind-build stage, so the inlined CSS matches what nginx
     serves in production. */
  const cliCmd = `npx --yes -p tailwindcss@3.4.17 tailwindcss --config "${tailwindConfigPath}" --input "${tailwindInputCssPath}" --output "${tmpOut}" --minify`;
  try {
    execSync(cliCmd, { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
  } catch (eCli) {
    console.error("FAIL: Tailwind compile failed. Command was:\n  " + cliCmd + "\n  " + (eCli && eCli.message ? eCli.message : eCli));
    process.exit(3);
  }
  if (!fs.existsSync(tmpOut)) {
    console.error("FAIL: Tailwind compile produced no output at " + tmpOut);
    process.exit(4);
  }
  twCss = fs.readFileSync(tmpOut, "utf8");
  fs.unlinkSync(tmpOut);
  fs.writeFileSync(cssCachePath, twCss, "utf8");
  console.log("Tailwind compiled: " + (twCss.length / 1024).toFixed(1) + " KB → cached at " + path.relative(repoRoot, cssCachePath));
}

/* Replace the <link rel="stylesheet" href="/tailwind.css" /> with the
   inline <style> block. We must escape any "</style>" sequences in
   the CSS (Tailwind doesn't emit any, but be defensive). */
const linkTagRegex = /<link\s+rel=["']stylesheet["']\s+href=["']\/tailwind\.css["']\s*\/?>/;
if (!linkTagRegex.test(out)) {
  console.error("FAIL: <link rel=stylesheet href=/tailwind.css> tag not found in index.html");
  process.exit(5);
}
const safeTwCss = twCss.replace(/<\/style>/gi, "<\\/style>");
const inlinedCss = `<style data-tailwind-inlined="true">\n/* INLINED Tailwind v3.4.17 compile output by scripts/regen-local-dashboard.mjs.\n   The deployed Docker image fetches /tailwind.css from nginx instead;\n   this inlining only affects Cummins_IDP_Dashboard.html so the local\n   file works offline (no network, no Cloudflare). */\n${safeTwCss}\n</style>`;
out = out.replace(linkTagRegex, () => inlinedCss);

fs.writeFileSync(outPath, out, "utf8");
console.log(`OK: wrote ${path.relative(repoRoot, outPath)} (${out.length.toLocaleString()} bytes; Tailwind inline: ${(twCss.length / 1024).toFixed(1)} KB)`);
