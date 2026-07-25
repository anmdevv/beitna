# Beitna Instagram Stats Bot v21

GitHub Actions + Playwright worker for updating public Instagram likes and Reel views.

v21 adds multiple play-count fallbacks:
- public page and network JSON
- embed/legacy JSON variants
- owner Reels-grid lookup for the same shortcode

The worker preserves existing values whenever Instagram does not expose a reliable number.
