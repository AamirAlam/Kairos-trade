import Anthropic from '@anthropic-ai/sdk';
import { runAgent, parseJson } from './base';
import { getFearGreed, getTokenPrices, getGlobalMetrics } from '../signals/cmc';
import { MarketBrief } from './types';

const SYSTEM_PROMPT = `You are a crypto market analyst specialising in BNB Smart Chain tokens.
Your job is to call the available tools, interpret the data, and produce a concise structured market brief.
Be objective. Identify the current regime, key signals, and 2-3 token opportunities with reasoning.
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
}`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_fear_greed',
    description: 'Returns the current Crypto Fear & Greed Index value and classification.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_token_prices',
    description: 'Returns price, 1h/24h change, and volume for a list of token symbols.',
    input_schema: {
      type: 'object' as const,
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of token symbols e.g. ["CAKE","BNB","PENDLE"]',
        },
      },
      required: ['symbols'],
    },
  },
  {
    name: 'get_global_metrics',
    description: 'Returns total market cap, BTC dominance, 24h volume, and market cap change.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
];

export async function runAnalyst(): Promise<MarketBrief> {
  const raw = await runAgent({
    role: 'Analyst',
    systemPrompt: SYSTEM_PROMPT,
    userMessage: 'Analyse current BSC market conditions and identify trading opportunities across the eligible token list. Focus on CAKE, PENDLE, FLOKI, BONK, and BNB as anchor tokens.',
    tools: TOOLS,
    toolHandlers: {
      get_fear_greed: async () => getFearGreed(),
      get_token_prices: async (input) => getTokenPrices(input.symbols as string[]),
      get_global_metrics: async () => getGlobalMetrics(),
    },
    maxTokens: 1024,
  });

  return parseJson<MarketBrief>(raw);
}
