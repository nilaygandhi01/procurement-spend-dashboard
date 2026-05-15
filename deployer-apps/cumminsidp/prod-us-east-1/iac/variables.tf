############
# Required #
############

variable "eks_oidc_provider_url" {
  description = "The OIDC provider URL of the EKS cluster"
  type        = string
  nullable    = false
}

variable "user_environment_id" {
  description = "The unique identifier of the user environment"
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-z0-9-]+$", var.user_environment_id))
    error_message = "User environment ID must be lowercase alphanumeric characters or hyphens"
  }
}

variable "pmck_instance_id" {
  description = "The PMcK instance ID"
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[a-zA-Z0-9]{8}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{12}$", var.pmck_instance_id))
    error_message = "PMcK instance ID must be alphanumeric characters separated by hyphens: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
}

variable "product_id" {
  description = "Product ID is 5 digits number from Firm's Product Catalogue: https://mckinsey.service-now.com/products"
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^[0-9]{5}$", var.product_id))
    error_message = "Product ID must be a 5-digit number"
  }
}

variable "used_for" {
  description = "The purpose of the resources"
  type        = string
  nullable    = false

  validation {
    condition     = can(regex("^(non_prod|prod|sbx)$", var.used_for))
    error_message = "Valid value: `non_prod`, `prod`, `sbx`"
  }
}

############
# Optional #
############

variable "subdomain_prefix" {
  description = "User-chosen subdomain prefix for the application URL (e.g. 'myapp'). Passed from lrah-control-plane via PMcK input. When set, a precise CORS origin https://{subdomain_prefix}.{zone} is added. When empty, no apps.mckinsey.com origin is added."
  type        = string
  default     = ""

  validation {
    condition     = var.subdomain_prefix == "" || can(regex("^[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]$", var.subdomain_prefix))
    error_message = "subdomain_prefix must be alphanumeric with hyphens (no leading/trailing hyphens), or empty"
  }
}

variable "rp_github_repo" {
  description = "GitHub repository path of this Resource Plane in `<org>/<repo>` format (e.g., `McK-Internal/my-rp`). Passed from lrah-control-plane via TFE workspace variable. The downstream `lrah` module requires this only when at least one `s3_buckets` entry opts into the per-bucket `S3Uploader` role; leave empty otherwise. The module-side precondition enforces the non-empty invariant conditionally. Shape-only validation here; the org allow-list is enforced by the firm `github-oidc-role` module downstream."
  type        = string
  nullable    = false
  default     = ""

  validation {
    condition     = var.rp_github_repo == "" || can(regex("^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", var.rp_github_repo))
    error_message = "rp_github_repo must be empty or match GitHub's `<org>/<repo>` format (e.g., `McK-Internal/my-rp`)."
  }
}