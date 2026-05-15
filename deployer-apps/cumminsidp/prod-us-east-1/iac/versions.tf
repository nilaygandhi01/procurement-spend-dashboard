terraform {
  required_version = ">=1.3, <1.12"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">=5.23, <7"
    }

    dns = {
      source  = "hashicorp/dns"
      version = ">=3, <4"
    }

    postgresql = {
      source  = "cyrilgdn/postgresql"
      version = ">=1.22, <2"
    }

    mysql = {
      source  = "petoju/mysql"
      version = ">=3.0, <4"
    }
  }
}
