/**
 * Tailwind v3 config for the procurement-spend-dashboard static site.
 *
 * Build-time scope
 * ----------------
 * We deliberately do NOT load the Tailwind Play CDN at runtime
 * (cdn.tailwindcss.com requires CSP 'unsafe-eval' for its in-browser
 * JIT, which we refuse to grant). Instead, the Tailwind standalone CLI
 * runs as a Docker build stage (see Dockerfile `tailwind-build`) and
 * statically extracts every utility class referenced in the files
 * listed under `content` below into a single minified tailwind.css
 * shipped alongside index.html. The resulting CSS file is loaded with
 * a vanilla <link rel="stylesheet"> from the same origin — no CDN, no
 * eval, no runtime JIT.
 *
 * Why these specific paths
 * ------------------------
 * Tailwind v3's content scanner is a regex-based extractor that picks
 * up any token that looks like a utility class in the scanned source
 * (HTML class="..." attributes, JS string literals, JSX className=, etc.).
 *
 *   - src/dashboard/index.html
 *       The dashboard itself. ~15,000 lines, ~4,000 lines of inline
 *       <script>, hundreds of class="..." sites, and 102 classList.*
 *       calls — all string-literal class names, so the scanner picks
 *       every one of them up.
 *
 *   - src/dashboard/landing.html
 *       Currently a meta-refresh redirect to index.html with zero
 *       Tailwind usage. Included so this config stays correct if
 *       landing.html ever grows real markup.
 *
 *   - src/dashboard/harmonization-client.js
 *       Sibling JS dependency loaded by index.html. Zero Tailwind
 *       references today, but included so that string-literal class
 *       additions there would be picked up automatically.
 *
 * Dynamic class construction (regression risk)
 * --------------------------------------------
 * The pre-refactor risk with precompiling Tailwind is that classes
 * constructed dynamically — e.g. `bg-${color}-500`, "p-" + size, or
 * any class name assembled from variables at runtime — would not be
 * present in the scanned source and would be silently omitted.
 *
 * A repo-wide grep for those patterns (template literals beginning
 * with `bg-`, `text-`, `border-`, `ring-`, `p-`, `m-`, `w-`, `h-`,
 * `grid-cols-`, etc., and string-concat patterns with the same
 * prefixes) returned ZERO matches across index.html, landing.html,
 * and harmonization-client.js. Likewise, no `@apply` directives
 * appear in the inline <style> block in index.html, so Tailwind has
 * no compile-time dependencies on user CSS either. The page should
 * render identically to the Play-CDN version.
 *
 * If a future change introduces dynamic class building, add the
 * affected classes to `safelist` below so they're always emitted.
 */
/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    'src/dashboard/index.html',
    'src/dashboard/landing.html',
    'src/dashboard/harmonization-client.js',
  ],
  theme: {
    extend: {},
  },
  // No dynamic class construction detected at the time of the
  // precompile cut-over (see comment above). Add entries here if/when
  // class names start being assembled from variables at runtime.
  safelist: [],
  plugins: [],
};
