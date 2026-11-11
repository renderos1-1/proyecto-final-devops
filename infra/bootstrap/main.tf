# One-time bootstrap, applied by a project owner from a workstation (local state).
# Creates what the main Terraform and GitHub Actions need before they can run:
#   - GCS bucket for remote Terraform state (versioned, private, native locking)
#   - Workload Identity Federation pool/provider for GitHub OIDC (no JSON keys)
#   - Least-privilege service accounts for CI (plan / apply / deploy)
#   - Billing budget with alert thresholds (US$100 cap)
# See docs/runbooks/bootstrap.md.

terraform {
  required_version = ">= 1.6"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
}

provider "google" {
  project               = var.project_id
  region                = var.region
  billing_project       = var.project_id
  user_project_override = true
}

data "google_project" "this" {}

locals {
  repo = "${var.github_owner}/${var.github_repo}"
  pool = google_iam_workload_identity_pool.github.name
}

# ---------------------------------------------------------------- state bucket
resource "google_storage_bucket" "tfstate" {
  name                        = "${var.project_id}-tfstate"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }

  lifecycle_rule {
    condition {
      num_newer_versions = 10
      with_state         = "ARCHIVED"
    }
    action {
      type = "Delete"
    }
  }
}

# ------------------------------------------------- GitHub OIDC (WIF) federation
resource "google_iam_workload_identity_pool" "github" {
  workload_identity_pool_id = "github"
  display_name              = "GitHub Actions"
}

resource "google_iam_workload_identity_pool_provider" "github" {
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"        = "assertion.sub"
    "attribute.repository"  = "assertion.repository"
    "attribute.ref"         = "assertion.ref"
    "attribute.environment" = "assertion.environment"
  }

  # Only tokens issued for this exact repository are accepted.
  attribute_condition = "assertion.repository == '${local.repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# ---------------------------------------------------------- service accounts
# tf-plan: read-only view of the project, used by PR workflows (any branch).
resource "google_service_account" "tf_plan" {
  account_id   = "gha-tf-plan"
  display_name = "GitHub Actions - terraform plan (read-only)"
}

# tf-apply: can change infrastructure; only usable from the `infra-prod` GitHub environment
# (which requires a reviewer approval).
resource "google_service_account" "tf_apply" {
  account_id   = "gha-tf-apply"
  display_name = "GitHub Actions - terraform apply"
}

# deployer: pushes images and opens an IAP tunnel to the K3s API. Kubernetes permissions
# are granted separately by a namespaced ServiceAccount token (see k8s/platform/rbac).
resource "google_service_account" "deployer" {
  account_id   = "gha-deployer"
  display_name = "GitHub Actions - build and deploy"
}

# Who may impersonate whom. All principals are already restricted to this repository by the
# provider's attribute_condition; the environment attribute comes from the job's `environment:`.
resource "google_service_account_iam_member" "tf_plan_wif" {
  service_account_id = google_service_account.tf_plan.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool}/attribute.repository/${local.repo}"
}

resource "google_service_account_iam_member" "tf_apply_wif" {
  service_account_id = google_service_account.tf_apply.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool}/attribute.environment/infra-prod"
}

resource "google_service_account_iam_member" "deployer_wif" {
  for_each           = toset(["dev", "prod"])
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool}/attribute.environment/${each.key}"
}

# Image publishing runs on pushes to main (no environment), so it gets a separate,
# narrower binding: the deployer SA, restricted to the main branch ref.
resource "google_service_account_iam_member" "deployer_wif_main" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${local.pool}/attribute.ref/refs/heads/main"
}

# Project roles.
resource "google_project_iam_member" "tf_plan" {
  for_each = toset([
    "roles/viewer",
    "roles/iam.securityReviewer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.tf_plan.email}"
}

resource "google_project_iam_member" "tf_apply" {
  for_each = toset([
    "roles/compute.admin",
    "roles/artifactregistry.admin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/resourcemanager.projectIamAdmin",
    "roles/serviceusage.serviceUsageConsumer",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.tf_apply.email}"
}

resource "google_project_iam_member" "deployer" {
  for_each = toset([
    "roles/iap.tunnelResourceAccessor", # IAP TCP forwarding to the K3s API (6443)
    "roles/compute.viewer",             # resolve the VM for the tunnel
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

# State bucket access: plan needs to read state and take the lock; apply needs read/write.
resource "google_storage_bucket_iam_member" "state_plan" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.tf_plan.email}"
}

resource "google_storage_bucket_iam_member" "state_apply" {
  bucket = google_storage_bucket.tfstate.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.tf_apply.email}"
}

# ------------------------------------------------------------------ budget
resource "google_billing_budget" "cap" {
  billing_account = var.billing_account
  display_name    = "${var.project_id} - US$${var.budget_usd} cap"

  budget_filter {
    projects               = ["projects/${data.google_project.this.number}"]
    credit_types_treatment = "EXCLUDE_ALL_CREDITS" # alert on gross usage even if credits cover it
  }

  amount {
    specified_amount {
      currency_code = "USD"
      units         = tostring(var.budget_usd)
    }
  }

  dynamic "threshold_rules" {
    for_each = [0.25, 0.5, 0.75, 0.9, 1.0]
    content {
      threshold_percent = threshold_rules.value
    }
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  # Default recipients: billing admins/users of the billing account receive the emails.
}
