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
# Runs the Tailwind standalone CLI against the dashboard sources and
# produces a single minified tailwind.css that the runtime nginx serves
# alongside index.html. Standalone CLI = single static binary, so no
# Node / npm / package.json / node_modules need exist in this repo.
FROM alpine:3.20 AS tailwind-build

# `TARGETARCH` is automatically populated by Docker BuildKit (`amd64` on
# GHA runners, `arm64` on Apple Silicon builders). We `ARG`-declare it
# so the value can flow into the RUN below; if BuildKit isn't active
# (legacy `docker build` without buildx) the RUN itself defaults the
# shell variable to `amd64`, so this works on the McKinsey self-hosted
# `gh-larger-linux-mini` runner regardless of which builder is in use.
ARG TARGETARCH

WORKDIR /build

# Tailwind CLI installer.
#
# `TAILWINDCSS_VERSION` is deliberately a plain shell variable set inside
# the RUN (instead of a Dockerfile ARG with a default) because the first
# attempt at this stage on the self-hosted runner produced a 404 from
# github.com/tailwindlabs/.../v/tailwindcss-linux-x64-musl — i.e. the
# `${TAILWINDCSS_VERSION}` substitution expanded to empty. The exact
# reason wasn't reproducible from the log alone (stage-scoped ARG with
# a default value SHOULD survive every builder I know of), but moving
# the pin into the shell removes the entire class of ARG-scoping /
# --build-arg-override / line-continuation failure modes. v3.4.17 is
# the latest v3 stable; both `tailwindcss-linux-x64-musl` and
# `tailwindcss-linux-arm64-musl` are real release assets for that tag.
# An `echo` of the constructed URL is included so any future download
# failure self-diagnoses in one build-log line.
RUN set -eu; \
    apk add --no-cache wget ca-certificates; \
    TAILWINDCSS_VERSION=3.4.17; \
    TARGETARCH="${TARGETARCH:-amd64}"; \
    case "$TARGETARCH" in \
        amd64) TWARCH=x64 ;; \
        arm64) TWARCH=arm64 ;; \
        *) echo "Unsupported TARGETARCH: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    URL="https://github.com/tailwindlabs/tailwindcss/releases/download/v${TAILWINDCSS_VERSION}/tailwindcss-linux-${TWARCH}-musl"; \
    echo "Downloading Tailwind CLI from: ${URL}"; \
    wget -q -O /usr/local/bin/tailwindcss "${URL}"; \
    chmod +x /usr/local/bin/tailwindcss; \
    /usr/local/bin/tailwindcss --help >/dev/null; \
    echo "Tailwind CLI installed: $(/usr/local/bin/tailwindcss --help 2>&1 | head -n 1)"

# Only bring in what Tailwind needs to scan. Keeping this scoped (rather
# than COPY . .) means a change to e.g. data/inputs/ won't invalidate
# the Tailwind layer cache.
COPY deploy/tailwind/tailwind.config.js ./tailwind.config.js
COPY deploy/tailwind/input.css ./input.css
COPY src/dashboard/ ./src/dashboard/

RUN tailwindcss \
        --config ./tailwind.config.js \
        --input  ./input.css \
        --output ./tailwind.css \
        --minify \
 && test -s ./tailwind.css \
 && echo "Tailwind CSS built: $(wc -c < ./tailwind.css) bytes"

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
