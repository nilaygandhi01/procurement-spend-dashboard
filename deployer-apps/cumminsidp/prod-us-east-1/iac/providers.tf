provider "aws" {
  default_tags {
    tags = {
      "ManagedByTFE" = "true"
      "product_id"   = var.product_id
      "used_for"     = var.used_for
    }
  }
}

provider "postgresql" {
  superuser = false
}
