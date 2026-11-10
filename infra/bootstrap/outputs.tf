output "state_bucket" {
  value = google_storage_bucket.tfstate.name
}

output "workload_identity_provider" {
  description = "Value for the GCP_WIF_PROVIDER GitHub variable"
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "sa_tf_plan" {
  value = google_service_account.tf_plan.email
}

output "sa_tf_apply" {
  value = google_service_account.tf_apply.email
}

output "sa_deployer" {
  value = google_service_account.deployer.email
}
