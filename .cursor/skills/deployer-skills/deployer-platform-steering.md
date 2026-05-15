# Deployer Platform Steering

Read-only reference guide for Deployer Cursor skills. This file is never modified --
it tells the agent where to find platform identity values and how to map them.

## Required Platform Identity Values

Deployer skills need the following platform identity values at runtime:

| Key | Description |
|-----|-------------|
| `account-id` | AWS workload account ID |
| `env-id` | Deployer environment identifier (also used as `namespace-id` in Vault paths) |
| `region` | AWS region |
| `product-id` | Numeric product identifier for this RP (used in Vault path prefix) |

## Source of Truth

The actual values live in the `values.yaml` header comments of the instance's
environment directory:

```
deployer-apps/{instance}/{env}-{region}/manifests/values.yaml
```

To discover the path, scan `deployer-apps/` for the instance directory, then
locate the `{env}-{region}/` subdirectory within it.

## Value Mapping

Extract the values from the `values.yaml` header comment block using this mapping:

| `values.yaml` comment key | Maps to |
|---------------------------|---------|
| `AWSWorkloadAccountID` | `account-id` |
| `EnvironmentID` | `env-id` / `namespace-id` (used in vault path and secretPath) |
| `AWSWorkloadRegion` | `region` |
| `app.kubernetes.io/lrah-user-product-id` label | `product-id` (used in vault path) |

## Agent Instructions

1. Read this steering file to learn the mapping above.
2. Discover the instance path by scanning `deployer-apps/`.
3. Read `values.yaml` and parse the header comments to extract all platform identity values.
4. Use those values for all naming formula substitutions throughout the skill session.
5. Never hardcode these values in skill files, rules, or steering documents.

---

## Platform Commands

> Read-only reference. Skills use these templates to build commands at runtime
> by substituting platform identity values. No skill modifies this section.

| Command | Template |
|---------|----------|
| SA role ARN lookup | `kubectl get configmap sa-role-{account-id}-{env-id} -n {env-id} -o jsonpath='{.data.arn}'` |
| Pipeline trigger | `gh workflow run {instance}-{env}-{region}-lrah-deploy-infra --ref main` |

---

## File Paths

> Read-only reference. Skills resolve concrete paths at runtime by substituting
> platform identity values. No skill modifies this section.

| Resource | Path template |
|----------|--------------|
| Terraform IaC | `deployer-apps/{instance}/{env}-{region}/iac/main.tf` |
| Helm values | `deployer-apps/{instance}/{env}-{region}/manifests/values.yaml` |
| PostgreSQL TF block | `postgresql_databases` map in `deployer-apps/{instance}/{env}-{region}/iac/main.tf` |
| MySQL TF block | `mysql_databases` map in `deployer-apps/{instance}/{env}-{region}/iac/main.tf` |
| IRSA key in values | `deployer.saReadWriteRoleARN` |
| Vault secrets path | `kvv2/{product-id}/{mount-suffix}/deployer-k8s-paas/{env-id}/app-secrets` |
| ExternalSecret name | `lrah-secret-generic` (constant — do not substitute) |

> `product-id` is derived from the label `app.kubernetes.io/lrah-user-product-id` in `values.yaml`.
> `mount-suffix` is the last segment of `VAULT_MOUNT_PATH` (from `gh variable list --env "$GH_ENVIRONMENT"`),
> normalized to hyphens (replace `_` with `-`). It is NOT derived from the instance name — a single
> mount may serve multiple RPs.
