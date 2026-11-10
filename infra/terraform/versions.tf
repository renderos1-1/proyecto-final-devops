terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }

  # Remote state in the bucket created by infra/bootstrap. GCS provides native state locking
  # (concurrent applies fail fast instead of corrupting state). Access is limited by IAM to
  # project owners and the gha-tf-plan / gha-tf-apply service accounts.
  backend "gcs" {
    bucket = "devops-esen-tfstate"
    prefix = "main"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
  zone    = var.zone
}
