# Matchday ESPN live-score monitor

This directory contains the free-tier Cloudflare Worker and SQLite-backed Durable Object that monitor ESPN scoreboards independently of an open browser. A one-minute Cron Trigger makes sure the single aggregate monitor is armed; Durable Object alarms perform recurring checks every 10 seconds. Competitions with a live match or kickoff within the next hour are checked about every 10 seconds; idle competitions are refreshed about every five minutes. The monitor stores both UTC dates covering the current Myanmar matchday and sends ESPN requests in batches of at most six, with a three-second timeout per request.

The website reads `GET /api/live?dates=YYYYMMDD,YYYYMMDD` from the Worker every 15 seconds while the current-day Matches screen is visible. Each browser read uses one Durable Object request for both date snapshots, reducing free-tier quota use. After ESPN publishes a change, the intended end-to-end polling delay is roughly 10–25 seconds plus network and rendering time; ESPN does not provide a push feed through this unofficial public scoreboard endpoint, so zero delay is not possible or guaranteed. The frontend retains its direct ESPN refresh as a fallback when the Worker is unavailable or another date is selected.

## Deploy

From this directory, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set in the command environment, run:

```sh
npx wrangler@4 deploy --config wrangler.jsonc
```

The SQLite Durable Object migration is declared in `wrangler.jsonc`. This configuration uses the free Workers plan only; do not enable or upgrade to a paid plan. Workers Free and Durable Objects have daily request/compute limits; over-limit usage is not automatically switched to a paid plan, and the feed may stop updating until quotas reset. Check the deploy output and account plan before proceeding if Cloudflare requests an upgrade.

## Verify

Use the deployed Worker URL from Wrangler's deploy receipt:

- `GET /health` reports the alarm, date snapshots, and failed-feed counts.
- `GET /api/live` returns both current Myanmar-matchday UTC snapshots after the first alarm populates them.

Run local checks with:

```sh
node --test worker.test.mjs
npx wrangler@4 deploy --dry-run --config wrangler.jsonc
```
