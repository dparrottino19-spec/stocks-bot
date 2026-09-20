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
  const interval = (req.query && req.query.interval) ? String(req.query.interval) : "1d";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=${encodeURIComponent(interval)}`;

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
        ts: new Date(timestamps[i] * 1000).toISOString(),
        date: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
        open: opens[i] ?? null,
        high: highs[i] ?? null,
        low: lows[i] ?? null,
        close: closes[i]
      });
    }

    // stats=anchor -> same-hour-to-same-hour 24h returns, bucketed by weekday.
    // Use with interval=1h to measure the ACTUAL holding window of the bot
    // (run-time to next run-time) rather than midnight-to-midnight.
    if (String((req.query && req.query.stats) || "") === "anchor") {
      const thr = Number((req.query && req.query.threshold) || 1.86);
      const hr = Number((req.query && req.query.anchorHour) || 11);
      const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      // pick one bar per calendar day at the anchor hour (UTC)
      const byDate = {};
      for (const b of bars) {
        const d = new Date(b.ts);
        if (d.getUTCHours() !== hr) continue;
        byDate[b.date] = b.close;
      }
      const dates = Object.keys(byDate).sort();
      const buckets = {};
      for (const n of NAMES) buckets[n] = { n: 0, exceed: 0, up: 0, sumAbs: 0, moves: [] };
      for (let i = 0; i < dates.length - 1; i++) {
        const d0 = dates[i], d1 = dates[i + 1];
        if ((Date.parse(d1) - Date.parse(d0)) / 86400000 !== 1) continue;
        const pct = ((byDate[d1] / byDate[d0]) - 1) * 100;
        const k = buckets[NAMES[new Date(d0 + "T00:00:00Z").getUTCDay()]];
        k.n += 1; k.sumAbs += Math.abs(pct);
        if (Math.abs(pct) > thr) k.exceed += 1;
        if (pct > 0) k.up += 1;
        k.moves.push(pct);
      }
      const out = NAMES.map(n => {
        const k = buckets[n];
        const sorted = k.moves.slice().sort((x, y) => x - y);
        return {
          fromDay: n,
          n: k.n,
          meanAbsPct: k.n ? +(k.sumAbs / k.n).toFixed(3) : null,
          medianPct: sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(3) : null,
          pctUp: k.n ? +((k.up / k.n) * 100).toFixed(1) : null,
          exceedCount: k.exceed,
          exceedPct: k.n ? +((k.exceed / k.n) * 100).toFixed(1) : null
        };
      });
      res.status(200).json({
        symbol, asOf: new Date().toISOString(), threshold: thr, anchorHourUTC: hr,
        note: "fromDay X = close of the anchorHour bar on X -> close of the anchorHour bar on X+1.",
        bars: bars.length, days: dates.length,
        firstDate: dates[0] || null, lastDate: dates[dates.length - 1] || null,
        stats: out
      });
      return;
    }

    // stats=dow -> per-day-of-week distribution of the NEXT-DAY close-to-close
    // absolute return, bucketed against a threshold (default 1.86%, the measured
    // Robinhood market-maker round-trip spread on spot crypto).
    if (String((req.query && req.query.stats) || "") === "dow") {
      const thr = Number((req.query && req.query.threshold) || 1.86);
      const NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const buckets = {};
      for (const n of NAMES) buckets[n] = { day: n, n: 0, exceed: 0, up: 0, sumAbs: 0, moves: [] };
      for (let i = 0; i < bars.length - 1; i++) {
        const a = bars[i], b = bars[i + 1];
        if (!a.close || !b.close) continue;
        // guard against gaps: only count consecutive calendar days
        const gap = (Date.parse(b.date) - Date.parse(a.date)) / 86400000;
        if (gap !== 1) continue;
        const dow = NAMES[new Date(a.date + "T00:00:00Z").getUTCDay()];
        const pct = ((b.close / a.close) - 1) * 100;
        const k = buckets[dow];
        k.n += 1;
        k.sumAbs += Math.abs(pct);
        if (Math.abs(pct) > thr) k.exceed += 1;
        if (pct > 0) k.up += 1;
        k.moves.push(pct);
      }
      const out = NAMES.map(n => {
        const k = buckets[n];
        const sorted = k.moves.slice().sort((x, y) => x - y);
        const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
        return {
          fromDay: k.day,
          n: k.n,
          meanAbsPct: k.n ? +(k.sumAbs / k.n).toFixed(3) : null,
          medianPct: med == null ? null : +med.toFixed(3),
          pctUp: k.n ? +((k.up / k.n) * 100).toFixed(1) : null,
          exceedCount: k.exceed,
          exceedPct: k.n ? +((k.exceed / k.n) * 100).toFixed(1) : null
        };
      });
      res.status(200).json({
        symbol,
        asOf: new Date().toISOString(),
        threshold: thr,
        note: "fromDay X = close(X) -> close(X+1) move. exceedPct = share of those moves whose ABSOLUTE size exceeds threshold.",
        bars: bars.length,
        firstDate: bars.length ? bars[0].date : null,
        lastDate: bars.length ? bars[bars.length - 1].date : null,
        stats: out
      });
      return;
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
