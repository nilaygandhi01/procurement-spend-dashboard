module "lrah" {
  source  = "terraform.mckinsey.cloud/FIRM-TF-MODULES/lrah/aws"
  version = "0.19.0"

  // PLATFORM CONFIGURATION **DO NOT EDIT**
  // The following variables are automatically populated by the platform
  eks_oidc_provider_url = var.eks_oidc_provider_url
  user_environment_id   = var.user_environment_id
  pmck_instance_id      = var.pmck_instance_id
  subdomain_prefix      = var.subdomain_prefix
  rp_github_repo        = var.rp_github_repo


  // USER CONFIGURATION
  // WARNING: replacing the name of the database will result in data loss as the database will be recreated
  postgresql_databases = {
    // create a database 'mydb' with an `owner` role as owner
    # "mydb" : {
    #   owner = "owner"
    #   roles = {
    #     "owner" : {
    #       generate_password = true
    #     }
    #   }
    # }
  }

  // WARNING: replacing the name of the database will result in data loss as the database will be recreated
  mysql_databases = {
    // create a MySQL database 'mydb' with an owner
    # "mydb" : {
    #   owner = {
    #     name               = "dbowner"
    #     iam_authentication = true   // set to false for password auth
    #   }
    # }
  }

  // WARNING: replacing the name of the bucket will result in data loss as the bucket will be recreated
  s3_buckets = {
    // create an s3 bucket 'mybucket' with default configuration
    # "mybucket" : {}

    // Procurement Spend Dashboard payload.
    // Full AWS bucket name resolved by the LRAH module as
    //   ${AWS_WORKLOAD_ACCOUNT_ID}-${USER_ENVIRONMENT_ID}-spend-data
    //   = 649941507750-cumminsidp-a8dd5-spend-data
    // The pod reads `s3://.../data.json` at startup via an initContainer
    // using IRSA — see deploy/helm/procurement-spend-dashboard/values.yaml
    // and deployer-apps/cumminsidp/prod-us-east-1/manifests/values.yaml
    // (key: `s3.bucket`). Refresh by re-uploading `data.json`; no chart
    // change required.
    //
    // `uploader` opts this bucket into the per-bucket
    //   S3-<account>-<env>-spend-data-S3Uploader
    // role. `ref = "*"` tells the firm `github-oidc-role` module to build
    // a trust policy with StringLike on `repo:<rp_github_repo>:*`, which
    // matches both branch-form (`repo:<repo>:ref:refs/heads/main`) and
    // environment-form (`repo:<repo>:environment:<env>`) OIDC sub claims.
    // The .github/workflows/cumminsidp-prod-us-east-1-lrah-upload-to-s3.yml
    // workflow assumes this role to push the refreshed data.json.
    //
    // Field name choice: previous attempt used `s3_uploader = { ref = "*" }`
    // (snake_case of the `S3Uploader` role suffix). After Deploy infra ran
    // "Success" against that, the trust policy did not update, suggesting the
    // LRAH module did not recognise that key (terraform did not error because
    // the s3_buckets input appears to accept arbitrary keys). The naming
    // convention used by sibling LRAH inputs in this same main.tf
    // (e.g. postgresql_databases.<db>.roles.<role>.generate_password,
    //  mysql_databases.<db>.owner.iam_authentication) is that inner field
    // names describe the FUNCTION without re-stating the parent map's
    // resource type. `uploader` follows that convention; `s3_uploader` did
    // not. Falling back to `uploader`.
    "spend-data" : {
      uploader = {
        ref = "*"
      }
    }
  }

  // WARNING: replacing the name of the queues will result in data loss as the queues will be recreated
  sqs_queues = {
    // create an sqs queue 'myqueue' with default configuration
    # "myqueue" : {}
  }
}
