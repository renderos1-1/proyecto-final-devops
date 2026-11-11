# Rebuild the environment from zero (DEV-13)

Everything is created by Terraform and versioned manifests. Manual steps are limited to identity,
the state backend, and secrets (spec 5.6), and each one is listed here.

## Prerequisites

| Tool | Version used |
|---|---|
| gcloud CLI | authenticated as a project Owner (`gcloud auth login`) |
| Terraform | >= 1.6 |
| kubectl | >= 1.33 |
| gh CLI | authenticated with admin rights on the repo |
| openssl | to generate secrets |

- A GCP project with billing linked (we use `devops-esen`).
- Terraform uses Application Default Credentials of a project Owner:
  `gcloud auth application-default login`.
  If `GOOGLE_APPLICATION_CREDENTIALS` is set in your shell (for example to another tool's service account key),
  it takes precedence over ADC. Run Terraform as `env -u GOOGLE_APPLICATION_CREDENTIALS terraform ...`.

## 1. Enable APIs (manual, once)

```bash
gcloud services enable compute.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com cloudresourcemanager.googleapis.com artifactregistry.googleapis.com \
  storage.googleapis.com iap.googleapis.com billingbudgets.googleapis.com cloudbilling.googleapis.com \
  serviceusage.googleapis.com --project devops-esen
```

## 2. Bootstrap: state bucket, GitHub OIDC federation, CI service accounts, budget (manual, once)

```bash
cd infra/bootstrap
cp terraform.tfvars.example terraform.tfvars    # set billing_account
mv backend.tf backend.tf.off                     # first run uses local state (the bucket doesn't exist yet)
terraform init && terraform apply
mv backend.tf.off backend.tf
terraform init -migrate-state                    # move bootstrap state into the bucket (prefix "bootstrap")
rm -f terraform.tfstate*
```

Copy the outputs into GitHub **repository variables** (Settings → Secrets and variables → Actions → Variables):
`GCP_PROJECT_ID`, `GCP_REGION`, `GCP_ZONE`, `GCP_WIF_PROVIDER`, `GCP_SA_TF_PLAN`, `GCP_SA_TF_APPLY`, `GCP_SA_DEPLOYER`.

Create GitHub environments `dev`, `prod`, `infra-prod`. If the plan allows it, give `prod` and `infra-prod` required reviewers.

## 3. Main infrastructure

Normally applied by the `terraform-apply` workflow after a PR merges. To do it by hand:

```bash
cd infra/terraform && terraform init && terraform plan -out tfplan && terraform apply tfplan
```

This creates the VPC, firewall (80/443 public; 22/6443 only from the IAP range), static IP, Artifact
Registry, the VM service account and the VM. The VM's startup script installs K3s (pinned version) and,
through K3s auto-deploy manifests, cert-manager, the NGINX Ingress Controller and the Let's Encrypt
ClusterIssuer. Watch progress with:

```bash
scripts/vm.sh ssh --command 'sudo tail -f /var/log/k3s-bootstrap.log'
```

## 4. Cluster access and platform objects (manual, after each VM rebuild)

```bash
scripts/vm.sh ssh --command 'sudo cat /etc/rancher/k3s/k3s.yaml' > ~/.kube/pfd-k3s.yaml
sed -i 's#127.0.0.1:6443#127.0.0.1:16443#' ~/.kube/pfd-k3s.yaml && chmod 600 ~/.kube/pfd-k3s.yaml
scripts/vm.sh tunnel &                         # IAP tunnel -> localhost:16443
export KUBECONFIG=~/.kube/pfd-k3s.yaml
kubectl apply -k k8s/platform                  # namespaces + per-environment deployer RBAC
kubectl -n observability create secret generic grafana-admin \
  --from-literal=admin-user=admin --from-literal=admin-password="$(openssl rand -base64 18)"
kubectl apply -k k8s/observability             # Prometheus/Alertmanager/Grafana, Loki, Tempo, OTel Collector
```

## 5. Secrets into GitHub environments (manual, after each VM rebuild)

The deployer tokens and the cluster CA change when the cluster is rebuilt. For each `env` in `dev prod`:

```bash
R=renderos1-1/proyecto-final-devops
kubectl -n ci get secret deployer-$env-token -o jsonpath='{.data.token}' | base64 -d | gh secret set KUBE_TOKEN --env $env -R $R
kubectl -n ci get secret deployer-$env-token -o jsonpath='{.data.ca\.crt}' | gh secret set KUBE_CA --env $env -R $R
# App secrets: generate once, keep them in a password manager. Rotating POSTGRES_PASSWORD needs an ALTER USER.
openssl rand -hex 24 | gh secret set POSTGRES_PASSWORD --env $env -R $R
echo "$(openssl rand -hex 20),$(openssl rand -hex 20)" | gh secret set INGEST_API_KEYS --env $env -R $R
openssl rand -hex 24 | gh secret set ADMIN_API_KEY --env $env -R $R
```

## 6. Deploy

Run the `release` workflow (Actions → release → Run workflow), or push a change under `app/`.
It builds the images, deploys to `dev`, then to `prod`.

## Verify

```bash
kubectl get nodes                                  # Ready
kubectl -n pfd-prod get deploy -o wide             # images tagged with the git SHA
curl -s https://api.<ip-dashed>.sslip.io/version   # {"gitSha": "<sha>"}
```

## Stop / destroy (DEV-14)

- **Pause (keeps data):** `scripts/vm.sh stop`. Compute charges stop; the disk and static IP keep billing (about US$0.25/day).
- **Destroy the infrastructure:** `cd infra/terraform && terraform destroy`. This deletes the VM, its disk (and with it **all cluster data**), the IP, the registry and the network.
- **Destroy everything:** after the above, `cd infra/bootstrap && terraform destroy`. The state bucket has
  `force_destroy = false`, so empty it first: `gcloud storage rm -r gs://devops-esen-tfstate/**`.
  Then, optionally, delete the project.

## Known manual interventions and why

| Step | Why it isn't automated |
|---|---|
| Enable APIs, bootstrap apply | Chicken-and-egg: the CI identity and state bucket don't exist yet (allowed by spec 5.6) |
| Copy kubeconfig, apply `k8s/platform` | Needs cluster-admin. CI identities are deliberately limited to their namespaces |
| Set KUBE_TOKEN / KUBE_CA / app secrets | Secrets must not live in git or Terraform state |
