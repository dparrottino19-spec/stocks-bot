# Stocks Bot — Paper Trading Dashboard

A public, always-on dashboard showing the state of two paper-trading books:

- **Weekly Trader** — Sunday 6pm ET picks, hold Mon→Fri.
- **Daily Trader** — Weekday 7am ET picks, per-pick exit rules.

Both books start at $70,000 and follow a 10% max-position rule.

## Architecture

- `index.html` — the dashboard (vanilla HTML/JS, no build step).
- `api/prices.js` — Vercel serverless function that proxies Yahoo Finance (avoids browser CORS).
- `data/weekly.json` & `data/daily.json` — current book state. Updated by scheduled Cowork tasks on the operator's Mac, then committed to this repo. Vercel auto-deploys.
- `data/history.json` — closed-week and closed-day performance.

## Hosting

Deployed to Vercel from this repo (auto-deploy on push to `main`). Public URL set at deploy time.

## Local development

Open `index.html` directly in a browser to render the dashboard. The `/api/prices` route only runs when deployed to Vercel; locally the dashboard will fall back to showing entry prices.

## Disclaimer

Paper trading only. Hypothetical performance. Not investment advice.
