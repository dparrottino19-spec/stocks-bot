// Vercel serverless function that proxies Yahoo Finance DAILY HISTORY.
//
// Companion to /api/prices. Returns a raw daily OHLC series so the bot can run
// statistical tests (e.g. "what fraction of Sat->Sun BTC moves exceed the
// round-trip spread?") from data instead of assertion.
//
// Query params:
//   symbol=BTC-USD        required, single symbol
//   days=730              optional, default 365, max 3650 — lookback window
//
// Response:
//   { symbol, asOf, count, bars: [{ date, open, high, low, close }] }
//   date is the UTC calendar date of the bar (YYYY-MM-DD).

const UA = { "User-Agent": "Mozilla/5.0 (compatible; stocks-bot/1.0)", "Accept": "application/json" };

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");

  const symbol = (req.query && req.query.symbol) ? String(req.query.symbol).trim().toUpperCase() : "";
  if (!symbol) {
    res.status(400).json({ error: "symbol query param is required, e.g. ?symbol=BTC-USD" });
    return;
  }

  let days = Number((req.query && req.query.days) || 365);
  if (!Number.isFinite(days) || days <= 0) days = 365;
  days = Math.min(Math.floor(days), 3650);

  const period2 = Math.floor(Date.now() / 1000) + 86400;
  const period1 = period2 - Math.floor(days * 86400) - 86400;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;

  try {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const result = data && data.chart && data.chart.result && data.chart.result[0];
    if (!result) throw new Error("no chart result in payload");

    const timestamps = result.timestamp || [];
    const q = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
    const opens = q.open || [];
    const highs = q.high || [];
    const lows = q.low || [];
    const closes = q.close || [];

    const bars = [];
    for (let i = 0; i < timestamps.length; i++) {
      if (closes[i] == null) continue;
      bars.push({
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: opens[i] ?? null,
        high: highs[i] ?? null,
        low: lows[i] ?? null,
        close: closes[i]
      });
    }

    res.status(200).json({
      symbol,
      asOf: new Date().toISOString(),
      count: bars.length,
      bars
    });
  } catch (err) {
    res.status(502).json({ symbol, error: String(err && err.message ? err.message : err), bars: [] });
  }
}
