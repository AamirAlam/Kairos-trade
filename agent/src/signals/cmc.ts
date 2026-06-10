import 'dotenv/config';

const CMC_BASE = 'https://pro-api.coinmarketcap.com';

async function cmcGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(`${CMC_BASE}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY ?? '' },
  });
  if (!res.ok) throw new Error(`CMC ${path} → ${res.status}`);
  return res.json();
}

// ── Fear & Greed ─────────────────────────────────────────────────────────────

export type FearGreedData = { value: number; value_classification: string };

export async function getFearGreed(): Promise<FearGreedData> {
  const data = await cmcGet('/v3/fear-and-greed/latest') as { data: FearGreedData };
  return { value: data.data.value, value_classification: data.data.value_classification };
}

// ── Token prices ──────────────────────────────────────────────────────────────

export type TokenPrice = {
  symbol: string;
  price_usd: number;
  percent_change_1h: number;
  percent_change_24h: number;
  volume_24h: number;
};

export async function getTokenPrices(symbols: string[]): Promise<TokenPrice[]> {
  type CmcQuote = { price: number; percent_change_1h: number; percent_change_24h: number; volume_24h: number };
  type CmcEntry = { symbol: string; quote: { USD: CmcQuote } };
  const data = await cmcGet('/v2/cryptocurrency/quotes/latest', {
    symbol: symbols.join(','),
    convert: 'USD',
  }) as { data: Record<string, CmcEntry[]> };

  return symbols.flatMap(sym => {
    const entries = data.data[sym];
    if (!entries?.length) return [];
    const entry = entries[0];
    const q = entry.quote.USD;
    return [{
      symbol: sym,
      price_usd: q.price,
      percent_change_1h: q.percent_change_1h,
      percent_change_24h: q.percent_change_24h,
      volume_24h: q.volume_24h,
    }];
  });
}

// ── Global metrics (dominance, total market cap) ──────────────────────────────

export type GlobalMetrics = {
  total_market_cap_usd: number;
  btc_dominance: number;
  eth_dominance: number;
  total_volume_24h: number;
  market_cap_change_24h: number;
};

export async function getGlobalMetrics(): Promise<GlobalMetrics> {
  const data = await cmcGet('/v1/global-metrics/quotes/latest', { convert: 'USD' }) as {
    data: {
      quote: { USD: { total_market_cap: number; total_volume_24h: number; total_market_cap_yesterday_percentage_change: number } };
      btc_dominance: number;
      eth_dominance: number;
    }
  };
  const q = data.data.quote.USD;
  return {
    total_market_cap_usd: q.total_market_cap,
    btc_dominance: data.data.btc_dominance,
    eth_dominance: data.data.eth_dominance,
    total_volume_24h: q.total_volume_24h,
    market_cap_change_24h: q.total_market_cap_yesterday_percentage_change,
  };
}

// ── Legacy combined fetch (kept for backward compat) ─────────────────────────

export type SignalData = {
  fearGreed: FearGreedData;
  regime: 'BULL' | 'BEAR' | 'NEUTRAL';
};

export async function fetchSignals(): Promise<SignalData> {
  const fearGreed = await getFearGreed();
  let regime: SignalData['regime'] = 'NEUTRAL';
  if (fearGreed.value >= 65) regime = 'BULL';
  else if (fearGreed.value <= 35) regime = 'BEAR';
  return { fearGreed, regime };
}
