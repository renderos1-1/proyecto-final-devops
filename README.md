# Proyecto final DevOps / Métricas de Software — Escenario 3: Ingesta y análisis de eventos

Event ingestion platform (NestJS + PostgreSQL) running on K3s on a GCP VM, provisioned with Terraform,
delivered with GitHub Actions, observed with Prometheus, Grafana, Loki, Tempo, and OpenTelemetry.

> The course spec targets Azure; the professor approved using **GCP (project `devops-esen`)** instead.

| Path | Contents |
|---|---|
| `app/` | NestJS ingest API + processor |
| `tools/generator/` | Reproducible event generator |
| `infra/bootstrap/` | One-time setup: Terraform state bucket, GitHub OIDC (Workload Identity Federation) |
| `infra/terraform/` | Main infrastructure: network, VM with K3s, Artifact Registry, budget |
| `k8s/` | Kubernetes manifests (Kustomize, dev/prod overlays) |
| `.github/workflows/` | CI, image publishing, deployment, Terraform |
| `docs/` | Spec, architecture, decisions, runbooks, metrics catalog |

See `docs/app-spec.md` for the app contract.
