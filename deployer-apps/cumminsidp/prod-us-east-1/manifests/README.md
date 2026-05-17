# `deployer-apps/cumminsidp/prod-us-east-1/manifests`

ArgoCD sync target for the **`cumminsidp`** Deployer instance, environment
**prod-us-east-1**.

## What lives here

- `procurement-spend-dashboard.yaml` — the rendered Kubernetes manifests
  (Service, Deployment, Ingress, NetworkPolicy) for the procurement
  spend dashboard, namespace `cumminsidp-a8dd5`.
- `kustomization.yaml` — a thin overlay that declares the namespace
  and common labels. ArgoCD detects the kustomization and uses it.

## Where the source of truth is

These manifests are **rendered output**, not hand-written. The source is:

```
deploy/helm/procurement-spend-dashboard/                # chart
deploy/helm/procurement-spend-dashboard/values-prod-us-east-1.yaml   # env overlay
```

Edit the chart or values file, then regenerate:

```powershell
# Windows
./scripts/render-manifests.ps1
```

```bash
# Linux / macOS
./scripts/render-manifests.sh
```

Both run `helm template` with the env values and write the result here.
Commit the resulting diff in the **same PR** as the values change.

## Why pre-rendered (not direct Helm sync)

- Works on any ArgoCD config (no `--enable-helm` on kustomize required,
  no `--application-namespaces` for child Applications).
- Reviewers can `git diff` the exact K8s objects ArgoCD will apply —
  important for client-data deployments where audit trail matters.
- Deterministic: no surprises at sync time from template logic changes.

The trade-off (re-render on chart change) is captured by the render
script.
