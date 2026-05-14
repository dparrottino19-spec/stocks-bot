// Vercel serverless function that proxies Yahoo Finance.
//
// Returns live quotes for the requested symbols, and (optionally) the % change
// of a benchmark index since a given start date — used for S&P 500 comparison.
//
// Query params:
//   symbols=AAPL,MSFT,...           required, comma-separated, max 50
//   benchmark=SPY                   optional, default "SPY". The index symbol to compare against.
//   benchmarkFrom=YYYY-MM-DD        optional. When provided, returns benchmark.startPrice & returnPct.

const UA = { "User-Agent": "Mozilla/5.0 (compatible; stocks-bot/1.0)", "Accept": "application/json" };

async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const meta = result && result.meta;
  const price = meta && (meta.regularMarketPrice ?? meta.previousClose);
  if (typeof price !== "number" || price <= 0) throw new Error("no price in payload");
  return {
    price,
    previousClose: meta.previousClose ?? null,
    currency: meta.currency ?? null,
    marketState: meta.marketState ?? null
  };
}

async function fetchBenchmark(symbol, fromDateISO) {
  // pad fromDate by 7d back to survive weekends/holidays; pad toDate by 2d forward for safety
  const fromMs = new Date(fromDateISO + "T00:00:00Z").getTime();
  if (!Number.isFinite(fromMs)) throw new Error("invalid benchmarkFrom");
  const period1 = Math.floor((fromMs - 7 * 86400_000) / 1000);
  const period2 = Math.floor((Date.now() + 2 * 86400_000) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const data = await r.json();
  const result = data && data.chart && data.chart.result && data.chart.result[0];
  const meta = result && result.meta;
  const timestamps = (result && result.timestamp) || [];
  const closes = (result && result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close) || [];

  // Find first close on or after fromDateISO (nearest trading day forward)
  const targetUnix = Math.floor(fromMs / 1000);
  let startPrice = null, startTs = null;
  for (let i = 0; i < timestamps.length; i++) {
    if (timestamps[i] >= targetUnix && closes[i] != null) {
      startPrice = closes[i];
      startTs = timestamps[i];
      break;
    }
  }
  // If no on-or-after data (e.g., fromDate is today and market hasn't opened), fall back to last available
  if (startPrice == null) {
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) { startPrice = closes[i]; startTs = timestamps[i]; break; }
    }
  }
  const currentPrice = meta && (meta.regularMarketPrice ?? meta.previousClose);
  if (typeof startPrice !== "number" || typeof currentPrice !== "number") {
    throw new Error("incomplete benchmark payload");
  }
  return {
    symbol,
    startDate: fromDateISO,
    startPrice,
    startTimestamp: startTs ? new Date(startTs * 1000).toISOString() : null,
    currentPrice,
    returnPct: ((currentPrice / startPrice) - 1) * 100
  };
}

export default async function handler(req, res) {
  const raw = (req.query && req.query.symbols) ? String(req.query.symbols) : "";
  const symbols = raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  const benchmarkSymbol = (req.query && req.query.benchmark) ? String(req.query.benchmark).toUpperCase() : "SPY";
  const benchmarkFrom = (req.query && req.query.benchmarkFrom) ? String(req.query.benchmarkFrom) : null;

  if (symbols.length === 0) {
    return res.status(400).json({ error: "symbols query param required (comma-separated)" });
  }
  if (symbols.length > 50) {
    return res.status(400).json({ error: "max 50 symbols per request" });
  }

  const prices = {};
  const errors = [];

  await Promise.all(symbols.map(async (symbol) => {
    try {
      prices[symbol] = await fetchQuote(symbol);
    } catch (e) {
      errors.push({ symbol, message: e.message });
    }
  }));

  let benchmark = null;
  if (benchmarkFrom) {
    try {
      benchmark = await fetchBenchmark(benchmarkSymbol, benchmarkFrom);
    } catch (e) {
      errors.push({ symbol: benchmarkSymbol, scope: "benchmark", message: e.message });
    }
  }

  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({
    asOf: new Date().toISOString(),
    count: Object.keys(prices).length,
    prices,
    benchmark,
    errors
  });
}
