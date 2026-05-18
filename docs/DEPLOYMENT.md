# Deploying the dashboard

> **Client-data warning.** This dashboard renders Cummins procurement spend.
> The only approved hosting target is **McKinsey-internal Deployer K8s PaaS**
> (instance: `cumminsidp`, Platform McKinsey workspace "Procurement IDP
> Dashboard"). The GitHub Pages and Netlify paths documented at the bottom
> of this file are **disabled for client data** and kept only for reference
> / for non-client demo data on a sanitized repo.

## Layout

- **Source dashboard**: `src/dashboard/index.html` (+ `harmonization-client.js`, assets).
- **Built data**: `python src/scripts/refresh_data.py` → `data/outputs/data.json`. **Never committed.**
- **PPI workbooks**: `data/inputs/indexes/*.xlsx` — public FRED data, bundled in container image.

## Deployer K8s PaaS (approved path)

### Repo layout for ArgoCD

```
deploy/helm/procurement-spend-dashboard/         # canonical Helm chart
  Chart.yaml
  values.yaml                                    # defaults
  values-prod-us-east-1.yaml                     # env overlay (image, host, CIDRs)
  templates/...

deployer-apps/cumminsidp/prod-us-east-1/manifests/   # ArgoCD sync target
  procurement-spend-dashboard.yaml               # rendered K8s objects
  kustomization.yaml                             # namespace + common labels
  README.md

scripts/
  render-manifests.sh    # render chart -> deployer-apps/.../manifests
  render-manifests.ps1
```

**ArgoCD is configured by the `cumminsidp` Deployer instance to sync from
`deployer-apps/cumminsidp/prod-us-east-1/manifests/`** — not from the
chart directory directly. The files under that path are **rendered
output** committed to git, so reviewers can diff exactly what ArgoCD will
apply. This avoids depending on `--enable-helm` for kustomize or
`--application-namespaces` for child Argo `Application` CRs.

When the chart or env values change:

```powershell
# Windows
./scripts/render-manifests.ps1
```

```bash
# Linux / macOS
./scripts/render-manifests.sh
```

Both run `helm template procurement-spend-dashboard deploy/helm/procurement-spend-dashboard --namespace cumminsidp-a8dd5 -f values-prod-us-east-1.yaml`
and write the result to the deployer-apps path. **Commit the resulting
diff in the same PR as the chart/values change** so the audit trail
(reviewed Helm change ↔ applied manifests) stays intact.

To add another environment (e.g. `prod-eu-west-1` or `nonprod-us-east-1`):

1. Add `values-<env>.yaml` next to the chart.
2. Append the tuple to the `ENVS` array in `scripts/render-manifests.{sh,ps1}`.
3. Run the render script. New manifests land at
   `deployer-apps/<tenant>/<env>/manifests/`.
4. Have Platform McKinsey point a new ArgoCD Application at that path.

### What ships in the image

| Layer | Contents |
|---|---|
| Static UI | `src/dashboard/` (HTML, JS, CSS) |
| Reference data | `data/inputs/indexes/*.xlsx` (FRED PPI series, public) |
| Server | nginx 1.27-alpine on port 8080, non-root |
| Config | `deploy/nginx/default.conf` (CSP, security headers, healthz) |

### What does NOT ship in the image

- `data/outputs/data.json` — **fetched from S3 at pod startup** via an
  `initContainer` (`amazon/aws-cli`) that copies the object into a shared
  `emptyDir` volume which nginx then serves at `/data.json`. The file is
  ~255 MB, well above the 1 MiB K8s Secret / ConfigMap etcd limit, so the
  Secret-based approach used in earlier drafts will not work and has been
  removed from this chart.
- Source spend workbooks — never leave the analyst laptop / Vault file storage

### One-time setup in Platform McKinsey

1. Confirm the `cumminsidp` Deployer instance is bound to this repo
   (`github.com/McK-Internal/cummins-idp-dashboard`). If your team
   uses GitHub Enterprise mirroring, set the internal mirror as the
   primary remote for deploy commits and demote the public origin to
   read-only.
2. Create the namespace (Deployer-assigned, e.g. `cumminsidp-a8dd5` for prod-us-east-1).
3. Provision a TLS cert for `cumminsidp.internal.mckinsey.com`
   (or whatever hostname your tenant assigns) and store the K8s secret
   as `cumminsidp-tls` in the namespace.
4. Wire Cloudflare Access for the hostname:
   - **Identity provider**: McKID SSO
   - **Policy**: firm-network only + group `procurement-idp-dashboard`
   - Update the placeholder annotations in
     `deploy/helm/procurement-spend-dashboard/values.yaml` with your
     tenant's exact annotation keys.
5. Add the S3 bucket to LRAH Terraform (one-time):
   In `deployer-apps/cumminsidp/prod-us-east-1/iac/main.tf`, the
   `s3_buckets` map already contains:

   ```hcl
   "spend-data" : {}
   ```

   Run **Deploy infra** from the Deployer / GitHub Actions UI so the LRAH
   module provisions the bucket and attaches read+write to the SA role.
   Resolved AWS bucket name:
   `649941507750-cumminsidp-a8dd5-spend-data` (region `us-east-1`).

### Refreshing the data

Locally on the analyst laptop (firm network only):

```bash
python src/scripts/refresh_data.py
# → data/outputs/data.json   (~255 MB)
```

Upload to S3 via the platform's **Upload to S3** workflow:

1. In the GitHub repo go to *Actions → "cumminsidp-prod-us-Upload to S3"*
   (workflow file: `.github/workflows/cumminsidp-prod-us-east-1-lrah-upload-to-s3.yml`).
2. Click **Run workflow**, set `bucket: spend-data`, dispatch. The action
   writes a short-lived STS credential to Vault for the
   `S3-...-spend-data-S3Uploader` role.
3. Use the Vault-backed creds (Platform McKinsey UI shows the path) to
   `aws s3 cp ./data/outputs/data.json s3://649941507750-cumminsidp-a8dd5-spend-data/data.json`
   from the analyst laptop. (Alternatively use the AWS S3 console in
   Platform McKinsey if your tenant exposes it.)

Roll the pod so the initContainer re-fetches:

```bash
kubectl -n cumminsidp-a8dd5 rollout restart deployment/procurement-spend-dashboard
```

(Or trigger an ArgoCD **Hard Refresh + Sync** on the
`procurement-spend-dashboard` application.)

### Source of truth

**`main` is the single deploy source of truth for this repo.** Every
chart/values/manifest change merges into `main`, and ArgoCD's
`Application.spec.source.targetRevision` for the `procurement-spend-
dashboard` app points at `main`. The Docker build workflow
(`cumminsidp-lrah-docker-build-and-publish.yml`) also fires on pushes
to `main` only.

A historical `deploy/k8s-paas` branch exists from the original Deployer
scaffold. It's kept in sync with `main` (fast-forward) so old tooling
that still references it doesn't break, but it is **no longer the
authoritative deploy branch**. Do not commit fixes only to
`deploy/k8s-paas` — they will be lost the next time `main` is
fast-forwarded onto it.

Why this matters: pushes to `main` between 2026-05-17 19:00 and 22:30
UTC (e.g. `bf5deeb` Docker-build CI fix, `36fe862` nginx /data.json
fix, `d4a9a87` CPU LimitRange fix) silently never reached ArgoCD
because the ArgoCD Application was still pointed at the stale
`deploy/k8s-paas` branch. That ambiguity is closed now.

#### Repointing ArgoCD's `targetRevision` (one-time operation)

If your live ArgoCD Application is still on `deploy/k8s-paas`, repoint
it once via **one** of the following. The CLI form is the most
auditable:

```bash
# Option 1 (preferred): argocd CLI — leaves an audit entry on the App.
argocd app set procurement-spend-dashboard --revision main

# Option 2: kubectl patch directly against the Application CR.
kubectl -n argocd patch application procurement-spend-dashboard \
  --type=merge \
  -p '{"spec":{"source":{"targetRevision":"main"}}}'
```

GUI form (Platform McKinsey / ArgoCD UI):

1. Open ArgoCD → application `procurement-spend-dashboard`.
2. App Details → **Edit** the `Source` panel.
3. Change `Target Revision` from `deploy/k8s-paas` to `main`.
4. Save → **Refresh** → **Sync**.

After repointing, the next merge to `main` propagates directly. The
`deploy/k8s-paas` branch can be archived/deleted at your discretion;
nothing in this repo depends on it.

### Build + push + deploy

The image build / push / ArgoCD sync is driven by Deployer — **not** by
this repo's GitHub Actions, and **not** locally. From Platform McKinsey:

1. Trigger a build on `main` via the `cumminsidp` Deployer instance.
   (`main` is the single source of truth; see "Source of truth" below.)
2. Deployer runs:
   - Container build using this repo's `Dockerfile` (root `Dockerfile`,
     not in `deploy/`).
   - Trivy / Twistlock image scan (must be 0 critical / 0 high).
   - Push to the tenant registry (replace `image.repository` in
     `values.yaml` with the registry path Deployer assigns).
   - ArgoCD `Application` syncs the Helm chart at
     `deploy/helm/procurement-spend-dashboard/` against the namespace.
3. Smoke-check `https://<host>/healthz` and the dashboard at `/index.html`.
   The data check is: open the dashboard, confirm spend totals on the
   Overview tab match the refresh log timestamp.

### Why this repo's GH Actions workflow is disabled

`.github/workflows/deploy-pages.yml` was disabled on 2026-05-17 by
removing its `push:` trigger. The file is kept (workflow_dispatch only)
so we can diff history. **Do not re-enable for the Cummins-data branch.**

### Why we don't use Netlify either

Netlify is public-internet hosting. Same reason: client data must not
egress to a third-party provider. The `netlify.toml` is retained only
in case a sanitized demo fork is ever published.

---

## GitHub Pages (DISABLED — do not enable for client data)

The original instructions are preserved here for reference. **None of
this is to be used for the Cummins instance.**

- Workflow: `.github/workflows/deploy-pages.yml` (push trigger removed).
- Publishes `src/dashboard/` to the public Pages URL.
- Would expose `data.json` and every spend row inside it to the entire
  internet once Pages is enabled for the repo.

If you fork this repo for a sanitized demo, you can re-add `push:` to
the workflow on the demo fork only.

## Netlify (DISABLED — do not enable for client data)

Same reasoning as above. `netlify.toml` is kept but should not be
deployed against any branch that carries real Cummins data.

## Data sensitivity (read me)

- `data/outputs/data.json` is **never** committed and **never** built
  into a container image.
- Source spend workbooks under `data/inputs/spend/` are local-only;
  verify they remain gitignored before any push.
- The image bundles only public FRED PPI workbooks
  (`data/inputs/indexes/*.xlsx`).
- All traffic to the dashboard is gated by Cloudflare Access + McKID SSO
  at the ingress; the K8s `NetworkPolicy` denies pod egress except DNS.
