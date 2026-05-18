# Secrets / sensitive-data scan — 2026-05-17

Scope: all tracked files in `McK-Internal/cummins-idp-dashboard`,
excluding `node_modules/`. Run against `main` (the deploy source of
truth — see `docs/DEPLOYMENT.md` "Source of truth") just before
generating the Deployer K8s PaaS bundle.

## Patterns checked

| Class | Pattern | Hits |
|---|---|---|
| AWS Access Key ID | `AKIA[0-9A-Z]{16}` | 0 |
| GitHub PAT | `gh[pousr]_[A-Za-z0-9_]{30,}` | 0 |
| Slack token | `xox[baprs]-[A-Za-z0-9-]{10,}` | 0 |
| OpenAI key | `sk-[A-Za-z0-9]{20,}` | 0 |
| Google API key | `AIza[0-9A-Za-z_-]{30,}` | 0 |
| Private key block | `-----BEGIN ... PRIVATE KEY-----` | 0 |
| Generic `(api_key|secret|password|token|auth)\s*[:=]\s*"..."` | regex | 0 |
| DB connection strings with creds | `mongodb/postgres/mysql/redis://...:...@...` | 0 |
| RFC1918 private IPs hardcoded | `10.*` / `192.168.*` / `172.16-31.*` | 0 |
| `.env*` files in repo | glob | 0 |

## Sensitive-but-not-credential findings

| Finding | Location | Action |
|---|---|---|
| Client name "Cummins" in UI, code, docs | ~25+ files (UI strings, `docs/AUDIT_REPORT.md`, `docs/CHANGES.md`, `README.md`, `src/dashboard/index.html`, `src/scripts/build_spend_data.py`) | **Keep**. Internal tool. Confirms scope at a glance. Do not strip. |
| FRED PPI workbooks (`PCU*.xlsx`, `WPU*.xlsx`) | `data/inputs/indexes/` | **Public reference data**. Safe to bundle in image (see Dockerfile). |
| `data/outputs/data.json` (the actual spend payload) | **Untracked**, regenerated locally via `src/scripts/refresh_data.py` | **Never bake into image.** ~255 MB — too large for K8s Secret/ConfigMap (1 MiB etcd cap). Stored in private S3 (`s3://649941507750-cumminsidp-a8dd5-spend-data/data.json`) and fetched by an `initContainer` into an `emptyDir` at pod startup via IRSA. See `deploy/helm/procurement-spend-dashboard/values.yaml` (`s3:` block). |
| Source spend workbooks (`data/inputs/spend/*.xlsx`) | Should be **untracked** — verify | Confirm `.gitignore` covers `data/inputs/spend/`. Inputs live on analyst laptops + Vault file storage, never in the repo. |

## What to move into Vault

Nothing **in code**. The only sensitive payload is `data.json`, and it is
NOT in code — it is a runtime artifact regenerated from the source spend
workbook each refresh. Recommended placement:

1. **`data.json` (latest build)** → private S3 bucket provisioned by LRAH:
   `s3://649941507750-cumminsidp-a8dd5-spend-data/data.json`. The pod
   pulls it at startup via an initContainer using IRSA. Vault is **not**
   used for the file itself; only short-lived STS credentials for the
   `S3Uploader` role flow through Vault during refresh (see
   `.github/workflows/cumminsidp-prod-us-east-1-lrah-upload-to-s3.yml`).
2. **Source spend workbook** → Vault file storage / OneDrive (firm-network)
   only. Never push into this repo.

There are no API tokens, DB creds, or third-party keys to migrate, because
the dashboard is a fully static front-end that reads `/data.json` and
bundled PPI workbooks via same-origin fetch.

## Conclusion

**Repo is clean of hardcoded credentials.** Deployment can proceed via
Deployer K8s PaaS. The only sensitive artifact is the S3-backed
`data.json` payload; it never enters the container image, the K8s Secret
store, or git, and access is gated by the LRAH-provisioned SA role with
per-bucket IAM policy (`SA-...-cumminsidp-a8dd5-ReadWrite`).
