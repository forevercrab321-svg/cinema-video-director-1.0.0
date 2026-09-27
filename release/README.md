# Release hand-off files

Built packages staged here so a browser agent can download them by URL and upload them to a portal
(the owner has no local copy). Rebuild with `node tools/build-portal.mjs <target>` (needs `.env.local`)
and copy the zip here; replace, don't accumulate old versions.

| File | For | Built |
| --- | --- | --- |
| `gamedistribution/grow-everything-gd.zip` | GameDistribution upload (GD SDK, game id c7b69794…, online rooms) | 2026-09-27, smoke test 14/14 |
| `gamedistribution/cover-*.png` | GD Assets page | from `marketing/press-kit/covers/` |
