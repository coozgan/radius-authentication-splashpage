terraform {
  required_version = ">= 1.5.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Recommended: Uncomment to store state in S3 with locking
  # backend "s3" {
  #   bucket         = "your-terraform-state-bucket"
  #   key            = "radius-auth/client-tracking/terraform.tfstate"
  #   region         = "ap-southeast-1"
  #   encrypt        = true
  #   dynamodb_table = "terraform-locks"
  # }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = "radius-auth"
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
