variable "project_id" {
  type    = string
  default = "devops-esen"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "zone" {
  type    = string
  default = "us-central1-a"
}

variable "machine_type" {
  description = "2 vCPU / 8 GB: K3s + app + Postgres + Prometheus/Grafana/Loki/Tempo share one node. See docs/decisions."
  type        = string
  default     = "e2-standard-2"
}

variable "boot_disk_gb" {
  type    = number
  default = 40
}

variable "k3s_version" {
  type    = string
  default = "v1.37.2+k3s1"
}

variable "nginx_ingress_chart_version" {
  description = "F5 NGINX Ingress Controller chart (helm.nginx.com/stable). Community ingress-nginx is retired."
  type        = string
  default     = "2.8.1"
}

variable "cert_manager_chart_version" {
  type    = string
  default = "v1.21.3"
}

variable "acme_email" {
  description = "Contact email for Let's Encrypt (expiry notices)."
  type        = string
  default     = "axel.renderos@marketflowsv.com"
}

variable "admin_iap_members" {
  description = "Principals allowed to SSH / open tunnels through IAP (e.g. user:alice@example.com)."
  type        = list(string)
  default     = ["user:axel.renderos@marketflowsv.com"]
}
