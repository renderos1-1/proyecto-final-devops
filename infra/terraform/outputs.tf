output "ingress_ip" {
  value = google_compute_address.ingress.address
}

output "domain" {
  description = "Public DNS name (sslip.io resolves it to the static IP)."
  value       = local.domain
}

output "app_hosts" {
  value = {
    prod    = "api.${local.domain}"
    dev     = "api-dev.${local.domain}"
    grafana = "grafana.${local.domain}"
  }
}

output "vm_name" {
  value = google_compute_instance.k3s.name
}

output "registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.images.repository_id}"
}

output "ssh_command" {
  value = "gcloud compute ssh ${google_compute_instance.k3s.name} --zone ${var.zone} --tunnel-through-iap"
}

output "kube_api_tunnel_command" {
  value = "gcloud compute start-iap-tunnel ${google_compute_instance.k3s.name} 6443 --local-host-port=localhost:16443 --zone ${var.zone}"
}
