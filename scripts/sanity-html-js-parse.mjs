/* Extract every <script> block from src/dashboard/index.html that isn't
 * marked type="module" or has a src= attribute, concatenate them, and ask
 * the V8 parser whether the whole thing is syntactically valid. Mirrors
 * what the browser sees on initial load.
 *
 * Catches the "SyntaxError at line ~10258" class of bugs before they
 * ship — invalid object keys, unterminated template literals, dangling
 * `+` at statement boundaries, etc.
 *
 * Run: node scripts/sanity-html-js-parse.mjs
 * Exits 0 if the parse succeeds, 1 otherwise.
 */
import fs from "node:fs";
import vm from "node:vm";

const PATH = "./src/dashboard/index.html";
const html = fs.readFileSync(PATH, "utf8");

// Greedy split on </script> boundaries then look at each chunk's leading
// <script…> tag. Crude but reliable enough for this one file.
const scriptOpen = /<script\b([^>]*)>/gi;
let m;
let combined = "";
let injectedAt = [];
let endIdx = 0;
while ((m = scriptOpen.exec(html)) !== null) {
  const attrs = m[1] || "";
  const startBody = m.index + m[0].length;
  const closeIdx = html.indexOf("</script>", startBody);
  if (closeIdx < 0) continue;
  if (/\bsrc\s*=/.test(attrs)) { endIdx = closeIdx; continue; }
  if (/type\s*=\s*["']module["']/i.test(attrs)) { endIdx = closeIdx; continue; }
  const body = html.slice(startBody, closeIdx);
  // Track which file-relative line the chunk starts at so error
  // messages map back to index.html line numbers.
  const startLine = html.slice(0, startBody).split(/\r?\n/).length;
  injectedAt.push({ startLine, length: body.split(/\r?\n/).length });
  combined += "\n//# script-chunk@line:" + startLine + "\n" + body;
  endIdx = closeIdx;
}

try {
  // Compile-only — don't actually evaluate. We just need V8 to parse it.
  new vm.Script(combined, { filename: "index.html#inline-scripts" });
  console.log("OK: all inline non-module <script> bodies parsed cleanly (" +
    injectedAt.length + " chunks, " + combined.length + " chars).");
  process.exit(0);
} catch (e) {
  console.error("PARSE ERROR:", e.message);
  if (e.stack) console.error(e.stack.split("\n").slice(0, 5).join("\n"));
  process.exit(1);
}
