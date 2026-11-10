# Added after the first local apply (the bucket must exist first). See docs/runbooks/bootstrap.md.
terraform {
  backend "gcs" {
    bucket = "devops-esen-tfstate"
    prefix = "bootstrap"
  }
}
