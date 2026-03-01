export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });

  const url = `https://brapi.dev/api/quote/${tickers}?token=bpJcy33PZ5aPFqGbxoP9dF`;
  const r = await fetch(url);
  const data = await r.json();
  res.setHeader("Cache-Control", "s-maxage=60");
  return res.status(200).json(data);
}
