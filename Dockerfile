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

# ---- Stage 1: stage static assets ----
FROM alpine:3.20 AS staging

WORKDIR /staging

# Copy the dashboard UI bundle.
COPY src/dashboard/ /staging/

# Copy public PPI workbooks next to index.html (same-origin fetch).
COPY data/inputs/indexes/*.xlsx /staging/

# IMPORTANT: do NOT copy data/outputs/data.json here. It is mounted from a
# K8s Secret at runtime. The file is also explicitly excluded by
# .dockerignore as a second line of defence.

# ---- Stage 2: runtime ----
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
