resource "google_artifact_registry_repository" "images" {
  repository_id = "pfd"
  location      = var.region
  format        = "DOCKER"
  description   = "Application images (ingest-api, processor), tagged with the git SHA"

  # Tags are immutable: a SHA tag always points to the same image (traceability).
  docker_config {
    immutable_tags = true
  }

  # Keep storage cost bounded: keep the 15 most recent versions per image, delete untagged after 7 days.
  cleanup_policies {
    id     = "keep-recent"
    action = "KEEP"
    most_recent_versions {
      keep_count = 15
    }
  }

  cleanup_policies {
    id     = "delete-untagged"
    action = "DELETE"
    condition {
      tag_state  = "UNTAGGED"
      older_than = "604800s"
    }
  }
}

# CI pushes images.
resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:gha-deployer@${var.project_id}.iam.gserviceaccount.com"
}

# The VM (and in-cluster token refresher) pulls images.
resource "google_artifact_registry_repository_iam_member" "node_reader" {
  location   = google_artifact_registry_repository.images.location
  repository = google_artifact_registry_repository.images.name
  role       = "roles/artifactregistry.reader"
  member     = "serviceAccount:${google_service_account.node.email}"
}
