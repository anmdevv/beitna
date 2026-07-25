# Beitna Instagram statistics worker

This folder is uploaded to a separate GitHub repository together with `.github/workflows/instagram-stats.yml`.
Do not upload `htdocs/config/config.php` or any website database password to GitHub.

Required repository secrets:
- `BEITNA_SITE_URL` — for example `https://example.com`
- `BEITNA_CRON_SECRET` — exact same value as `BEITNA_GITHUB_SECRET` in `htdocs/config/platform-api.php`

Optional:
- `INSTAGRAM_SESSIONID` — a session cookie from an Instagram account you control. It can improve access to public posts, but it may expire. Never commit it to the repository.
