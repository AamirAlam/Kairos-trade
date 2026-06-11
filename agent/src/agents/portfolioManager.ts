import Anthropic from '@anthropic-ai/sdk';
import { runAgent, parseJson, ToolHandler } from './base';
import { MarketBrief, TradeProposal } from './types';
import { getRecentTrades } from '../db/queries';
import { quoteSwap } from '../execution';

const SYSTEM_PROMPT = `You are a portfolio manager for an autonomous BSC trading agent.
Given a market brief, your open positions, and portfolio state, decide what single trade to make — or HOLD.
Be decisive but size conservatively. Prefer tokens with strong signal confluence.
You MUST call get_recent_trades before deciding, and call get_swap_quote before any BUY or SELL.

Position discipline:
- Take-profit and stop-loss are handled automatically — do NOT propose exits just to lock small gains.
- Only propose a SELL if the thesis has clearly broken (signal reversal), even if TP/SL not yet hit.
- Do NOT propose a BUY for a token you already hold (no pyramiding). Choose a different token or HOLD.
- Reserve confidence "HIGH" for genuine signal confluence (TA + sentiment + narrative align). Most ticks should be MEDIUM/LOW or HOLD. Only HIGH-confidence BUYs get executed.

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

export type OpenPositionSummary = {
  token: string;
  bnbSpent: number;
  entryPriceUsd: number;
  currentPriceUsd: number;
  unrealizedPnlPct: number;
};

export async function runPortfolioManager(
  brief: MarketBrief,
  portfolioUsd: number,
  bnbBalance: number,
  maxTradeBnb: number,
  openPositions: OpenPositionSummary[] = [],
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

  const positionsBlock = openPositions.length > 0
    ? openPositions.map(p =>
        `- ${p.token}: ${p.bnbSpent.toFixed(4)} BNB in @ $${p.entryPriceUsd.toPrecision(4)}, now $${p.currentPriceUsd.toPrecision(4)} (${p.unrealizedPnlPct >= 0 ? '+' : ''}${(p.unrealizedPnlPct * 100).toFixed(2)}% unrealized)`
      ).join('\n')
    : '- None — all in BNB';

  const context = `
## Market Brief
${JSON.stringify(brief, null, 2)}

## Open Positions
${positionsBlock}

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
