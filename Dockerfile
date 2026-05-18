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
# Uses node:20-alpine + npm-installed tailwindcss instead of the v3
# standalone CLI binary because:
#   * The v3 standalone Linux assets (tailwindcss-linux-x64 /
#     -arm64 / -armv7) are built with @yao-pkg/pkg and link against
#     GLIBC. Running a glibc binary on alpine:3.20 (musl libc) fails
#     with `not found: /lib/ld-linux-*.so.2`. We'd need to add the
#     gcompat shim or switch to a Debian base.
#   * The musl-suffixed assets (-x64-musl / -arm64-musl) only exist
#     starting with Tailwind v4 — they were never published for any
#     v3.x release. v3.4.17 has no -musl asset (verified against
#     github.com/tailwindlabs/tailwindcss/releases/tag/v3.4.17).
# The npm-installed package is pure JS, runs anywhere Node runs, and
# is immune to asset-name drift across versions — only the version
# pin on the `npm install` line below ever changes.
FROM node:20-alpine AS tailwind-build

WORKDIR /build

# Bring in just the Tailwind config + input CSS first so the (slow,
# network-heavy) npm install layer below stays in the cache across
# UI-only changes to src/dashboard/.
COPY deploy/tailwind/tailwind.config.js ./tailwind.config.js
COPY deploy/tailwind/input.css ./input.css

# Install Tailwind v3.4.17 locally — same v3 line the Play CDN was
# serving, so class semantics and the JS-based tailwind.config.js
# schema are unchanged. `npm init -y` is needed because Tailwind's
# postinstall expects to be inside an npm project; otherwise it
# silently no-ops on certain installer paths.
RUN set -eu; \
    npm init -y >/dev/null; \
    npm install --no-audit --no-fund --no-progress --silent tailwindcss@3.4.17; \
    echo "tailwindcss installed: $(npx tailwindcss --help 2>&1 | head -n 1)"

# Now bring in the dashboard sources Tailwind scans. Layered after
# the npm install so UI edits don't bust the install layer.
COPY src/dashboard/ ./src/dashboard/

# Compile to a single minified stylesheet. Stage 2 will COPY this
# into /staging/tailwind.css alongside index.html.
RUN set -eu; \
    npx tailwindcss \
        --config ./tailwind.config.js \
        --input  ./input.css \
        --output ./tailwind.css \
        --minify; \
    test -s ./tailwind.css; \
    echo "Tailwind CSS built: $(wc -c < ./tailwind.css) bytes"

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

# Healthcheck endpoint is the index page itself.
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/index.html >/dev/null || exit 1

# Run as the unprivileged 'nginx' user already present in the base image.
USER nginx

CMD ["nginx", "-g", "daemon off;"]
