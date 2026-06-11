import { runAgent, parseJson } from './base';
import { getCmcMcpTools } from '../signals/cmcMcp';
import { MarketBrief } from './types';

const SYSTEM_PROMPT = `You are a professional crypto market analyst specialising in BNB Smart Chain tokens.
You have access to CoinMarketCap's full data suite — use it thoroughly before concluding.

Required research steps (call tools in this order):
1. get_global_metrics_latest — overall market regime, Fear & Greed, BTC dominance, altcoin season
2. get_global_crypto_derivatives_metrics — funding rates, open interest, liquidations
3. get_crypto_technical_analysis — RSI, MACD, EMA for your top candidate tokens
4. trending_crypto_narratives — which narratives are gaining momentum right now
5. get_crypto_latest_news — any breaking events that could affect BSC tokens
6. get_upcoming_macro_events — macro headwinds or tailwinds in the next 24-48h

Only after gathering data from at least steps 1–4, produce your final JSON brief.

Respond ONLY with a JSON object matching this exact shape — no markdown, no explanation outside the JSON:
{
  "regime": "BULL" | "BEAR" | "NEUTRAL",
  "fearGreed": number,
  "fearGreedLabel": string,
  "fundingRate": number | null,
  "sentiment": string | null,
  "topOpportunities": string[],
  "keyRisks": string[],
  "summary": string
}

Rules:
- topOpportunities: 2-4 items, each naming a specific token with a 1-line reason (e.g. "CAKE — MACD bullish cross, RSI 42 recovering from oversold")
- keyRisks: 2-3 items
- summary: ≤ 2 sentences capturing regime + strongest signal
- Use actual numbers from the data (RSI values, funding rates, F&G score)`;

export async function runAnalyst(): Promise<MarketBrief> {
  const { tools, handlers } = await getCmcMcpTools();

  const raw = await runAgent({
    role: 'Analyst',
    systemPrompt: SYSTEM_PROMPT,
    userMessage: `Analyse current BSC market conditions using the CoinMarketCap tools.
Focus on BSC-native tokens: CAKE, PENDLE, FLOKI, BONK, LISTA, THE, XVS, ALPACA.
Check technical analysis for at least 3 of these tokens before forming your view.
Use get_crypto_technical_analysis with interval=daily for each token you analyse.`,
    tools,
    toolHandlers: handlers,
    maxTokens: 2048,
  });

  return parseJson<MarketBrief>(raw);
}
