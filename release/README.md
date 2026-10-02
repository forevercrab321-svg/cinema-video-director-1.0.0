# Release hand-off files

Built packages staged here so a browser agent can download them by URL and upload them to a portal
(the owner has no local copy). Rebuild with `node tools/build-portal.mjs <target>` (needs `.env.local`)
and copy the zip here; replace, don't accumulate old versions.

| File | For | Built |
| --- | --- | --- |
| `gamedistribution/grow-everything-gd.zip` | GameDistribution upload (GD SDK, game id c7b69794…, online rooms) | 2026-10-01 rev 3 (audit fixes: room browser, server-confirmed host, English-first, boot screen, perf), smoke 9/10 on the package (the 1 failure = sandbox blocks external SDK/backend) |
| `gamedistribution/cover-*.png` | GD Assets page | from `marketing/press-kit/covers/` |
| `crazygames/grow-everything-crazygames.zip` | CrazyGames upload (CrazyGames SDK only — their terms forbid other portals' SDKs; online rooms, SDK v3 rooms/invites/username) | 2026-10-02 rev 5: Halloween Town + The Hunt (6 seats, 10 min, 3 bosses) + Egg Valley / 蛋之谷 (hidden girl, honk → 10 s invisible + 1/3 score), hunt rebalanced, guest-honk fix; real boss names compiled out of portal builds (neutral nicknames only). Smoke 9/10 on the package (the 1 failure = sandbox blocks the external SDK/backend). 31 files (no SVG), largest < 9 MB. Hand the browser agent the zip itself (1 attachment); never flatten the folders (index.html loads `assets/…`) |
| `crazygames/cover-*.png`, `crazygames/*-*s.png` | CrazyGames covers and screenshots | from `marketing/press-kit/` |
| `crazygames/crazygames-submission-bundle.zip` | One download for the CrazyGames submission: the build zip + 3 covers + 3 screenshots (unzip, then hand the 7 files to the browser agent) | 2026-10-01 |
| `crazygames/preview-landscape.mp4`, `crazygames/preview-portrait.mp4` | CrazyGames required preview videos (1920×1080 and 1080×1920, 12.5 s, 24 fps, H.264): real gameplay captured frame-exact with `tools/capture-clip.mjs` (New York from 55 s / Shanghai from 40 s) | 2026-10-01 |
