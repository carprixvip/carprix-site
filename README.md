# carprixapp.com — public site (GitHub Pages)

Static site of **Carprix, LLC** — luxury automotive experiences by quarterly subscription ("choose. sign. drive.").

- Source of truth for the pages: `carprixvip/carprix-billing` → `site/` (Design agent). This repository receives the published copy; do not edit here.
- Hosting: GitHub Pages (branch `main`, root), custom domain `carprixapp.com` (`CNAME`), HTTPS enforced. `www` → CNAME `carprixvip.github.io`.
- Billing API: `https://billing.carprixapp.com` (`carprix-billing` stack, `carprix-billing-prod`).
- Legal pages (`/terms/`, `/privacy/`, `/refund-policy/`) carry `noindex` until counsel approval.
