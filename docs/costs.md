# Cost control (DEV-14)

Budget cap: **US$100** for the project (course rule). Billing account currency: USD.

## Estimate (us-central1, on-demand list prices)

| Resource | Unit price | Running 24/7 (30 d) | Planned usage |
|---|---|---|---|
| VM e2-standard-2 (2 vCPU, 8 GB) | ~US$0.067/h | ~US$49 | ~US$16 (≈240 h over the project) |
| Boot disk pd-balanced 40 GB | ~US$0.10/GB-month | US$4 | US$5 (≈5 weeks) |
| Static external IPv4 | ~US$0.005/h (billed even while the VM is stopped) | US$3.6 | US$4.5 |
| Artifact Registry | ~US$0.10/GB-month (cleanup policy keeps 15 versions) | < US$0.50 | < US$0.50 |
| GCS state bucket | cents | < US$0.05 | < US$0.05 |
| Network egress | ~US$0.12/GB after free tier | < US$1 | < US$1 |
| **Total** | | **~US$58/month if never stopped** | **~US$27 expected** |

Leaving the VM on 24/7 for the whole ~6 weeks (≈US$85) would come close to the cap. The rule is
to **stop the VM when nobody is working on it**.

## Controls in place

1. **Budget alerts:** `google_billing_budget.cap` (infra/bootstrap) emails billing admins at 25/50/75/90/100% of
   actual spend and at 100% of *forecasted* spend. Credits are excluded, so the alert reflects real usage.
   Budget alerts **do not stop resources** by themselves.
2. **Stop when idle:** `scripts/vm.sh stop` / `start`. A stopped VM bills no compute. The disk and IP still bill.
3. **Sizing:** one node; requests are sized from observed usage (see `docs/resources.md`); no managed DB, no load balancer
   (K3s ServiceLB uses the VM's own IP, which saves the ~US$18/month a GCP load balancer would cost).
4. **Registry cleanup policy:** keeps the 15 newest versions and deletes untagged images after 7 days.
5. **Teardown:** `terraform destroy` (see `docs/runbooks/rebuild.md`).

## Observed charges

Fill in from Billing → Reports (filter project `devops-esen`), weekly:

| Date | Cumulative cost (USD) | Notes |
|---|---|---|
| 2026-11-10 | 0.00 | Infrastructure created |
