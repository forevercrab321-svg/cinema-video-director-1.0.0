# Release hand-off files

Built packages staged here so a browser agent can download them by URL and upload them to a portal
(the owner has no local copy). Rebuild with `node tools/build-portal.mjs <target>` (needs `.env.local`)
and copy the zip here; replace, don't accumulate old versions.

| File | For | Built |
| --- | --- | --- |
| `gamedistribution/grow-everything-gd.zip` | GameDistribution upload (GD SDK, game id c7b69794…, online rooms) | 2026-10-01 rev 3 (audit fixes: room browser, server-confirmed host, English-first, boot screen, perf), smoke 9/10 on the package (the 1 failure = sandbox blocks external SDK/backend) |
| `gamedistribution/cover-*.png` | GD Assets page | from `marketing/press-kit/covers/` |
| `crazygames/grow-everything-crazygames.zip` | CrazyGames upload (CrazyGames SDK only — their terms forbid other portals' SDKs; online rooms, SDK v3 rooms/invites/username) | 2026-10-01 rev 3 (same fixes; no GD code in the bundle) |
| `crazygames/cover-*.png`, `crazygames/*-*s.png` | CrazyGames covers and screenshots | from `marketing/press-kit/` |
