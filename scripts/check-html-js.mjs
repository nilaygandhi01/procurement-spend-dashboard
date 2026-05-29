// Smoke-test the regenerated Cummins_IDP_Dashboard.html — extract each
// inline <script> block and ensure each one parses as valid JS. The
// regen pipeline has historically broken on $& replacement-pattern
// tokens, so this is the cheapest way to catch a parse regression
// before the file goes through a browser.
import fs from "node:fs";
import path from "node:path";

const file = process.argv[2] || "src/dashboard/Cummins_IDP_Dashboard.html";
let html = fs.readFileSync(file, "utf8");
/* Strip HTML comments before extracting script blocks so a comment
   that mentions `<script src=...>` literally doesn't get parsed as
   JavaScript. */
html = html.replace(/<!--[\s\S]*?-->/g, "");
const re = /<script\b[^>]*>([\s\S]*?)<\/script>/g;
let m, idx = 0, errors = 0;
while ((m = re.exec(html))) {
  idx++;
  try {
    new Function(m[1]);
  } catch (e) {
    errors++;
    console.log("Script block #" + idx + " parse error: " + e.message.slice(0, 200));
  }
}
console.log("Checked " + idx + " inline script blocks; errors: " + errors);
process.exit(errors ? 1 : 0);
