# Identity of the VM: only what the node needs (write logs/metrics to GCP, pull images).
resource "google_service_account" "node" {
  account_id   = "k3s-node"
  display_name = "K3s node VM"
}

resource "google_project_iam_member" "node" {
  for_each = toset([
    "roles/logging.logWriter",
    "roles/monitoring.metricWriter",
  ])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.node.email}"
}

locals {
  domain = "${replace(google_compute_address.ingress.address, ".", "-")}.sslip.io"
}

resource "google_compute_instance" "k3s" {
  name         = "pfd-k3s"
  machine_type = var.machine_type
  zone         = var.zone
  tags         = ["k3s"]

  boot_disk {
    initialize_params {
      image = "ubuntu-os-cloud/ubuntu-2404-lts-amd64"
      size  = var.boot_disk_gb
      type  = "pd-balanced"
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    access_config {
      nat_ip = google_compute_address.ingress.address
    }
  }

  service_account {
    email  = google_service_account.node.email
    scopes = ["cloud-platform"] # effective permissions are limited by the IAM roles above
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  metadata = {
    enable-oslogin         = "TRUE" # SSH access governed by IAM, no static keys
    block-project-ssh-keys = "TRUE"
    startup-script = templatefile("${path.module}/templates/startup.sh.tftpl", {
      k3s_version                 = var.k3s_version
      nginx_ingress_chart_version = var.nginx_ingress_chart_version
      cert_manager_chart_version  = var.cert_manager_chart_version
      acme_email                  = var.acme_email
    })
  }

  # The startup script is idempotent and re-runs on every boot. Changing it should not
  # recreate the VM (that would wipe cluster data); it applies on next reboot.
  lifecycle {
    ignore_changes = [metadata["startup-script"]]
  }

  allow_stopping_for_update = true
}

# Admins may SSH (OS Login) and tunnel through IAP.
resource "google_project_iam_member" "admin_oslogin" {
  for_each = toset(var.admin_iap_members)
  project  = var.project_id
  role     = "roles/compute.osAdminLogin"
  member   = each.value
}

resource "google_project_iam_member" "admin_iap" {
  for_each = toset(var.admin_iap_members)
  project  = var.project_id
  role     = "roles/iap.tunnelResourceAccessor"
  member   = each.value
}
