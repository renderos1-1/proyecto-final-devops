resource "google_compute_network" "main" {
  name                    = "pfd-vpc"
  auto_create_subnetworks = false
}

resource "google_compute_subnetwork" "main" {
  name          = "pfd-subnet"
  network       = google_compute_network.main.id
  region        = var.region
  ip_cidr_range = "10.10.0.0/24"
}

# Static IP so the DNS name (sslip.io) and TLS certificate stay valid across VM stop/start.
# Note: a reserved IP is billed while the VM is stopped (see docs/costs.md).
resource "google_compute_address" "ingress" {
  name   = "pfd-ingress-ip"
  region = var.region
}

# Public: only HTTP (ACME challenge + redirect) and HTTPS.
resource "google_compute_firewall" "web" {
  name          = "pfd-allow-web"
  network       = google_compute_network.main.name
  direction     = "INGRESS"
  source_ranges = ["0.0.0.0/0"]
  target_tags   = ["k3s"]

  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}

# Admin: SSH and the Kubernetes API (6443) only from Google's IAP TCP-forwarding range.
# Callers must also hold roles/iap.tunnelResourceAccessor, so neither port is reachable from
# the internet.
resource "google_compute_firewall" "iap_admin" {
  name          = "pfd-allow-iap-admin"
  network       = google_compute_network.main.name
  direction     = "INGRESS"
  source_ranges = ["35.235.240.0/20"]
  target_tags   = ["k3s"]

  allow {
    protocol = "tcp"
    ports    = ["22", "6443"]
  }
}
