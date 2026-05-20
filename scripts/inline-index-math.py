#!/usr/bin/env python3
"""Inline `src/dashboard/index-math.mjs` into `src/dashboard/index.html`
inside a regular `<script>` block.

Why: the original `<script type="module">` shim that imported the .mjs
file at runtime is brittle — any of (.mjs MIME-type misconfiguration,
network 404, CORS, CSP module-src strictness) silently drops
`window.IDP_INDEX_MATH`, and the chart hangs forever on "Loading chart
math…". Inlining the module body as plain JS eliminates all four
failure modes at once and makes the IA tab work on the absolute
minimum runtime — `python -m http.server`, nginx with no special MIME
config, anything.

The .mjs file remains the source of truth (Node tests import it
directly). This script rewrites the inline copy in index.html between
two sentinel comments so re-runs are idempotent:

    /* IDP_INDEX_MATH_INLINE_BEGIN — generated from index-math.mjs by scripts/inline-index-math.py */
    ...generated body...
    /* IDP_INDEX_MATH_INLINE_END */

Run:
    py scripts/inline-index-math.py
"""
from __future__ import annotations

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MJS = os.path.join(ROOT, "src", "dashboard", "index-math.mjs")
HTML = os.path.join(ROOT, "src", "dashboard", "index.html")

BEGIN = "/* IDP_INDEX_MATH_INLINE_BEGIN — generated from index-math.mjs by scripts/inline-index-math.py */"
END = "/* IDP_INDEX_MATH_INLINE_END */"


def build_inline_block(mjs_body: str) -> str:
    # 1) Strip the top-of-file `export { ... };` block (ES-module syntax that
    #    would syntax-error in a classic <script>).
    body = re.sub(r"export\s*\{[^}]*\};?\s*$", "", mjs_body.strip(), flags=re.DOTALL).rstrip()

    # 2) Discover the symbols we need to attach to window. We could just
    #    re-parse the `export {}` we stripped, but it's simpler to find every
    #    top-level `function NAME(` and `const NAME =` and white-list those.
    #    (We exclude internal helpers prefixed with `_` for hygiene.)
    fn_names = re.findall(r"^function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(", mjs_body, flags=re.MULTILINE)
    const_names = re.findall(r"^const\s+([A-Z_][A-Z0-9_]*)\s*=", mjs_body, flags=re.MULTILINE)
    # Filter out internal helpers
    fn_names = [n for n in fn_names if not n.startswith("_")]

    exports = sorted(set(fn_names + const_names))
    if not exports:
        print("[error] no exports detected", file=sys.stderr)
        sys.exit(1)

    attach = ",\n      ".join(f"{n}: {n}" for n in exports)

    block = f"""    <script>
      /* {BEGIN.replace("/*", "").replace("*/", "").strip()}
       *
       * DO NOT EDIT THIS BLOCK BY HAND. Source of truth is
       * src/dashboard/index-math.mjs. Re-run
       *   py scripts/inline-index-math.py
       * after any change to that file. The .mjs version is still imported
       * by scripts/tests/index-math.test.mjs (Node test runner); only the
       * BROWSER copy is inlined here so the dashboard never has to fetch a
       * .mjs file at runtime (which broke in production when nginx didn't
       * advertise a JavaScript MIME type for the .mjs extension).
       */
      (function (root) {{
{indent(body, 8)}

        root.IDP_INDEX_MATH = {{
      {attach}
        }};
        try {{ root.dispatchEvent(new Event("idp-index-math-ready")); }} catch (e) {{}}
      }})(typeof window !== "undefined" ? window : globalThis);
      {END}
    </script>"""
    return block


def indent(src: str, n: int) -> str:
    pad = " " * n
    return "\n".join(pad + line if line else line for line in src.split("\n"))


def main():
    mjs = open(MJS, "r", encoding="utf-8").read()
    html = open(HTML, "r", encoding="utf-8").read()

    inline = build_inline_block(mjs)

    # Find an existing inlined block first; if absent, replace the legacy
    # `<script type="module"> import * as IDP_INDEX_MATH from "./index-math.mjs"; ...`
    # shim.
    pat_existing = re.compile(
        r"    <script>\n      /\* IDP_INDEX_MATH_INLINE_BEGIN.*?IDP_INDEX_MATH_INLINE_END \*/\n    </script>",
        re.DOTALL,
    )
    if pat_existing.search(html):
        html2 = pat_existing.sub(lambda m: inline, html, count=1)
        action = "replaced existing inline block"
    else:
        # Match the legacy module shim. Tolerate small whitespace drift.
        pat_module = re.compile(
            r'    <script type="module">\s*\n\s*import \* as IDP_INDEX_MATH from "\./index-math\.mjs";.*?</script>',
            re.DOTALL,
        )
        if not pat_module.search(html):
            print("[error] couldn't find the module shim or an existing inline block. Aborting.", file=sys.stderr)
            sys.exit(2)
        html2 = pat_module.sub(lambda m: inline, html, count=1)
        action = "replaced legacy module shim"

    with open(HTML, "w", encoding="utf-8", newline="\n") as f:
        f.write(html2)
    print(f"OK: {action}; new file size: {len(html2)} chars")


if __name__ == "__main__":
    main()
