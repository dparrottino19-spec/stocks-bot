// Vercel serverless function that proxies Yahoo Finance.
// Browser CORS prevents direct Yahoo Finance calls; this server-side proxy returns
// JSON the dashboard can consume from a same-origin /api/prices?symbols=AAPL,MSFT call.

export default async function handler(req, res) {
  const raw = (req.query && req.query.symbols) ? String(req.query.symbols) : "";
  const symbols = raw.split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

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
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
      const r = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; stocks-bot/1.0)",
          "Accept": "application/json"
        }
      });
      if (!r.ok) {
        errors.push({ symbol, status: r.status, message: `HTTP ${r.status}` });
        return;
      }
      const data = await r.json();
      const result = data && data.chart && data.chart.result && data.chart.result[0];
      const meta = result && result.meta;
      const price = meta && (meta.regularMarketPrice ?? meta.previousClose);
      if (typeof price === "number" && price > 0) {
        prices[symbol] = {
          price,
          previousClose: meta.previousClose,
          currency: meta.currency,
          marketState: meta.marketState
        };
      } else {
        errors.push({ symbol, message: "no price in payload" });
      }
    } catch (e) {
      errors.push({ symbol, message: e.message });
    }
  }));

  // 60s edge cache, allow stale for 5 min while refreshing in background
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=300");
  res.status(200).json({
    asOf: new Date().toISOString(),
    count: Object.keys(prices).length,
    prices,
    errors
  });
}
