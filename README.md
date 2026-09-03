# carprix.vip — public site (GitHub Pages)

Published copy of the Carprix site ("choose. sign. drive.").

- Source of truth for the pages: `carprixvip/carprix-billing` → `site/` (Design agent). This repository receives the published copy; do not edit here.
- Hosting: GitHub Pages (branch `main`, root), custom domain `carprix.vip` (`CNAME`), HTTPS enforced. DNS (Route 53 zone of carprix.vip, account 375036628454): apex A/AAAA → GitHub Pages, `www` CNAME `carprixvip.github.io` (GitHub redirects www → apex).
- Legacy hosts `carprixapp.com` / `www.carprixapp.com` answer 301 → `https://carprix.vip` (CloudFront + ACM, `carprix-billing/infra/redirect/`, decision D20 of 2026-09-03).
- Billing API: `https://billing.carprixapp.com` (`carprix-billing` stack, `carprix-billing-prod`); Stripe custom domain `pay.carprixapp.com`.
- Sync (from the Mac working copy): `rsync -a --delete --exclude .git --exclude CNAME --exclude README.md --exclude robots.txt --exclude sitemap.xml "$HOME/mnt/Projects/Carprix/carprix-billing/site/" ./` then commit + push.
