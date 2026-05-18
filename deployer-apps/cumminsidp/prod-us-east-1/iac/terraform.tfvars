# Terraform variable overrides for this RP / environment.
#
# `rp_github_repo` is the `<org>/<repo>` whose GitHub Actions OIDC token
# is permitted to assume the per-bucket `S3Uploader` role created when a
# bucket entry in `s3_buckets` opts in via `s3_uploader = { ref = "*" }`.
#
# When the lrah-control-plane sets `TF_VAR_rp_github_repo` (or a workspace
# variable) on the TFE workspace, that takes precedence over this file —
# so leaving this in the repo as a default is safe.
#
# This value MUST match the repo that runs
# .github/workflows/cumminsidp-prod-us-east-1-lrah-upload-to-s3.yml.
# If you fork or mirror the repo, update this value to the new path.
rp_github_repo = "McK-Internal/cummins-idp-dashboard"
