# Procurement Spend Dashboard — static site image for Deployer K8s PaaS.
#
# Design notes:
#   * Multi-stage build keeps the runtime image minimal (nginx:alpine).
#   * Sensitive payload (Cummins spend `data.json`, ~255 MB) is NOT baked
#     into the image. An initContainer (`amazon/aws-cli`) downloads it from
#     S3 into a shared emptyDir at pod startup, and nginx mounts the file
#     at /usr/share/nginx/html/data.json (see Helm chart `s3:` block).
#   * Listens on 8080 so the container can run as a non-root user that
#     cannot bind <1024.
#   * FRED PPI workbooks (data/inputs/indexes/*.xlsx) ARE bundled — they are
#     public reference data, copied next to index.html so the front-end's
#     same-origin fetch resolves.
#   * Tailwind CSS is PRECOMPILED in the `tailwind-build` stage (see
#     deploy/tailwind/). The Play CDN (cdn.tailwindcss.com) is no longer
#     loaded at runtime because its in-browser JIT requires CSP
#     'unsafe-eval', which the nginx CSP intentionally withholds.

# ---- Stage 1: precompile Tailwind CSS ----
# Uses the Tailwind v3 standalone CLI binary on alpine:3.20. The build
# stage stays tiny (~7 MB base + ~43 MB binary + a few configs) and
# cold-build is fast (~5 sec wget vs. ~30 sec npm install).
#
# Asset selection notes (this took two attempts to land correctly):
#   * Tailwind v3 publishes ONE binary per Linux arch:
#       tailwindcss-linux-x64      (43 MB, 617k+ downloads)
#       tailwindcss-linux-arm64    (41 MB)
#       tailwindcss-linux-armv7    (36 MB)
#     There is NO -musl-suffixed variant. The `-musl` naming was
#     introduced in Tailwind v4, which moved the CLI to oxide/Rust.
#     For v3, the single Linux binary works on BOTH musl (Alpine)
#     and glibc (Debian/Ubuntu) — verified against the v3.4.17
#     download counts (617k+ for tailwindcss-linux-x64; if it were
#     glibc-only, the Tailwind project would have shipped a -musl
#     fallback for Alpine users).
#   * Asset list verified live against
#     api.github.com/repos/tailwindlabs/tailwindcss/releases/tags/v3.4.17.
FROM alpine:3.20 AS tailwind-build

# `TARGETARCH` is auto-populated by Docker BuildKit (`amd64` on GHA
# runners, `arm64` on Apple Silicon). If BuildKit isn't active (legacy
# `docker build` without buildx, which is the case on the McKinsey
# self-hosted `gh-larger-linux-mini` runner) the RUN below defaults
# the shell variable to `amd64`.
ARG TARGETARCH

WORKDIR /build

# Tailwind v3 standalone CLI installer.
#
# `TAILWINDCSS_VERSION` is a plain shell variable set inside the RUN
# (not a Dockerfile ARG with a default) to eliminate every possible
# ARG-scoping / --build-arg-override / line-continuation failure mode
# — an earlier attempt at this stage on the self-hosted runner saw
# `${TAILWINDCSS_VERSION}` expand to empty for reasons I couldn't pin
# down from the partial log.
#
# Asset name: `tailwindcss-linux-${TWARCH}` WITHOUT a -musl suffix
# (see the stage-header comment above for why).
RUN set -eu; \
    apk add --no-cache wget ca-certificates; \
    TAILWINDCSS_VERSION=3.4.17; \
    TARGETARCH="${TARGETARCH:-amd64}"; \
    case "$TARGETARCH" in \
        amd64) TWARCH=x64 ;; \
        arm64) TWARCH=arm64 ;; \
        *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    URL="https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWINDCSS_VERSION}/tailwindcss-linux-${TWARCH}"; \
    echo "Downloading Tailwind CLI from: ${URL}"; \
    wget -q -O /usr/local/bin/tailwindcss "${URL}"; \
    chmod +x /usr/local/bin/tailwindcss; \
    /usr/local/bin/tailwindcss --help >/dev/null; \
    echo "Tailwind CLI installed: $(/usr/local/bin/tailwindcss --help 2>&1 | head -n 1)"

# Only bring in what Tailwind needs to scan. Keeping this scoped
# (rather than COPY . .) means a change to e.g. data/inputs/ won't
# invalidate the Tailwind layer cache.
COPY deploy/tailwind/tailwind.config.js ./tailwind.config.js
COPY deploy/tailwind/input.css ./input.css
COPY src/dashboard/ ./src/dashboard/

# Compile + LOUD sanity checks. Build #19 (cf53048) succeeded all the
# way through this stage but the deployed image had no /tailwind.css,
# suggesting either (a) the file was produced but content-scanning
# found nothing (so the output was just a few KB of preflight) or (b)
# the file was lost between stages by a cache/COPY mishap. The four
# guards below convert each silent failure mode into a build-failing
# error with a self-explanatory message.
RUN set -eu; \
    echo "=== tailwind-build: workdir contents BEFORE compile ==="; \
    ls -la /build || true; \
    echo "=== tailwind-build: dashboard sources Tailwind will scan ==="; \
    ls -la /build/src/dashboard/ || true; \
    echo "=== tailwind-build: invoking tailwindcss CLI ==="; \
    tailwindcss \
        --config ./tailwind.config.js \
        --input  ./input.css \
        --output ./tailwind.css \
        --minify; \
    test -f ./tailwind.css \
      || { echo "FATAL: /build/tailwind.css was not created by the CLI"; exit 1; }; \
    test -s ./tailwind.css \
      || { echo "FATAL: /build/tailwind.css exists but is EMPTY"; exit 1; }; \
    SIZE=$(wc -c < ./tailwind.css); \
    echo "Tailwind CSS built: ${SIZE} bytes"; \
    grep -q '\.hidden' ./tailwind.css \
      || { echo "FATAL: /build/tailwind.css does not contain the .hidden utility — content scan likely matched zero source files. Check that tailwind.config.js content[] paths resolve relative to /build (the config file's directory)."; exit 1; }; \
    echo "Sanity OK: /build/tailwind.css contains .hidden utility (content scan worked)"

# ---- Stage 2: stage static assets ----
FROM alpine:3.20 AS staging

WORKDIR /staging

# Copy the dashboard UI bundle.
COPY src/dashboard/ /staging/

# Copy public PPI workbooks next to index.html (same-origin fetch).
COPY data/inputs/indexes/*.xlsx /staging/

# Drop in the precompiled Tailwind stylesheet from stage 1. The
# <link rel="stylesheet" href="/tailwind.css"> in index.html resolves
# against this file at the document root.
COPY --from=tailwind-build /build/tailwind.css /staging/tailwind.css

# Sanity check: confirm tailwind.css landed in /staging/ before the
# runtime stage tries to pull it in. If this fails, the regression
# was in the COPY --from=tailwind-build above.
RUN set -eu; \
    test -s /staging/tailwind.css \
      || { echo "FATAL: /staging/tailwind.css is missing or empty after COPY --from=tailwind-build"; exit 1; }; \
    echo "Sanity OK: /staging/tailwind.css present ($(wc -c < /staging/tailwind.css) bytes)"; \
    echo "=== staging: /staging/ contents ==="; \
    ls -la /staging/ | head -n 30

# IMPORTANT: do NOT copy data/outputs/data.json here. It is fetched from
# S3 by an initContainer at pod startup (see the file-level comment
# above and the Helm chart `s3:` block). The file is also explicitly
# excluded by .dockerignore as a second line of defence.

# ---- Stage 3: runtime ----
FROM nginx:1.27-alpine

# Drop privileges. The official nginx image runs as root by default; we
# rewrite the config to listen on 8080 and use writable temp paths so the
# container can run as a non-root user in K8s (see Helm securityContext).
RUN rm -f /etc/nginx/conf.d/default.conf
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf

# Copy static bundle from staging.
COPY --from=staging /staging/ /usr/share/nginx/html/

# Sanity checks for the two locally-served assets that index.html
# references (everything else is either inline or fetched from an
# allow-listed CDN — see deploy/nginx/default.conf script-src/style-src):
#
#   /tailwind.css                — Tailwind compile output (built in
#                                   stage 1, carried through stage 2).
#   /harmonization-client.js     — Sibling JS module loaded by
#                                   index.html via a relative <script>
#                                   tag. Defines the global
#                                   `HarmonizationClient` IIFE that
#                                   applyPayloadToD() and 113 other
#                                   sites in index.html call into; if
#                                   it's missing, the page reaches the
#                                   "Processing spend cube / Interning
#                                   rows…" overlay and then throws on
#                                   the first HarmonizationClient.*
#                                   reference, showing a Retry button
#                                   that never recovers.
#
# Without these guards, a missing file silently degrades to nginx's
# SPA fallback (`try_files $uri $uri/ /index.html;`) serving
# index.html with Content-Type: text/html in response to a request
# for a CSS or JS path. The browser then tries to parse HTML as the
# expected asset type and the page either renders unstyled
# (CSS case) or stalls on a ReferenceError (JS case).
RUN set -eu; \
    test -s /usr/share/nginx/html/tailwind.css \
      || { echo "FATAL: /usr/share/nginx/html/tailwind.css is missing or empty after COPY --from=staging"; exit 1; }; \
    echo "Sanity OK: /usr/share/nginx/html/tailwind.css present ($(wc -c < /usr/share/nginx/html/tailwind.css) bytes)"; \
    test -s /usr/share/nginx/html/harmonization-client.js \
      || { echo "FATAL: /usr/share/nginx/html/harmonization-client.js is missing or empty after COPY --from=staging"; exit 1; }; \
    echo "Sanity OK: /usr/share/nginx/html/harmonization-client.js present ($(wc -c < /usr/share/nginx/html/harmonization-client.js) bytes)"; \
    test -s /usr/share/nginx/html/index.html \
      || { echo "FATAL: /usr/share/nginx/html/index.html is missing or empty after COPY --from=staging"; exit 1; }; \
    echo "Sanity OK: /usr/share/nginx/html/index.html present ($(wc -c < /usr/share/nginx/html/index.html) bytes)"; \
    echo "=== runtime: /usr/share/nginx/html/ contents ==="; \
    ls -la /usr/share/nginx/html/ | head -n 30

# Healthcheck endpoint is the index page itself.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/index.html >/dev/null || exit 1

# Run as the unprivileged 'nginx' user already present in the base image.
USER nginx

CMD ["nginx", "-g", "daemon off;"]
