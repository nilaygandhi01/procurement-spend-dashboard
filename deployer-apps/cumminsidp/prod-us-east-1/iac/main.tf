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
  }

  // WARNING: replacing the name of the queues will result in data loss as the queues will be recreated
  sqs_queues = {
    // create an sqs queue 'myqueue' with default configuration
    # "myqueue" : {}
  }
}
