import Anthropic from '@anthropic-ai/sdk';
import { runAgent, parseJson, ToolHandler } from './base';
import { MarketBrief, TradeProposal } from './types';
import { getRecentTrades } from '../db/queries';
import { quoteSwap } from '../execution';

const SYSTEM_PROMPT = `You are a portfolio manager for an autonomous BSC trading agent.
Given a market brief and current portfolio state, decide what single trade to make — or HOLD.
Be decisive but size conservatively. Prefer tokens with strong signal confluence.
You MUST call get_recent_trades before deciding, and call get_swap_quote before any BUY or SELL.
Respond ONLY with a JSON object — no markdown, no explanation outside the JSON:
{
  "action": "BUY" | "SELL" | "HOLD",
  "token": string,
  "amountBnb": number,
  "reasoning": string,
  "confidence": "HIGH" | "MEDIUM" | "LOW"
}
For HOLD: set token to "" and amountBnb to 0.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_recent_trades',
    description: 'Returns the last 10 trades this agent has made, including token, side, amount, and outcome.',
    input_schema: { type: 'object' as const, properties: {}, required: [] },
  },
  {
    name: 'get_swap_quote',
    description: 'Gets a quote for a potential swap on BSC. Returns expected rate and price impact.',
    input_schema: {
      type: 'object' as const,
      properties: {
        token: { type: 'string', description: 'Token symbol e.g. CAKE' },
        side: { type: 'string', enum: ['BUY', 'SELL'], description: 'BUY = BNB→token, SELL = token→BNB' },
        amountBnb: { type: 'number', description: 'Amount in BNB' },
      },
      required: ['token', 'side', 'amountBnb'],
    },
  },
];

export async function runPortfolioManager(
  brief: MarketBrief,
  portfolioUsd: number,
  bnbBalance: number,
  maxTradeBnb: number,
): Promise<TradeProposal> {
  const toolHandlers: Record<string, ToolHandler> = {
    get_recent_trades: async () => getRecentTrades(10),
    get_swap_quote: async (input) => {
      try {
        return await quoteSwap({
          token: input.token as string,
          side: input.side as 'BUY' | 'SELL',
          amountBnb: input.amountBnb as number,
          signal: 'quote-check',
        });
      } catch {
        return { error: 'Quote unavailable' };
      }
    },
  };

  const context = `
## Market Brief
${JSON.stringify(brief, null, 2)}

## Current Portfolio
- Portfolio value: $${portfolioUsd.toFixed(2)}
- BNB balance: ${bnbBalance.toFixed(4)} BNB
- Max trade size: ${maxTradeBnb.toFixed(4)} BNB (10% of balance — hard limit, do not exceed)
`.trim();

  const raw = await runAgent({
    role: 'PortfolioManager',
    systemPrompt: SYSTEM_PROMPT,
    userMessage: context,
    tools: TOOLS,
    toolHandlers,
    maxTokens: 1024,
  });

  return parseJson<TradeProposal>(raw);
}
