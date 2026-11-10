variable "project_id" {
  type    = string
  default = "devops-esen"
}

variable "region" {
  type    = string
  default = "us-central1"
}

variable "billing_account" {
  description = "Billing account ID (XXXXXX-XXXXXX-XXXXXX). Not a secret, but kept out of git via terraform.tfvars."
  type        = string
}

variable "budget_usd" {
  type    = number
  default = 100
}

variable "github_owner" {
  type    = string
  default = "renderos1-1"
}

variable "github_repo" {
  type    = string
  default = "proyecto-final-devops"
}
