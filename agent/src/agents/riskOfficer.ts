import { runAgent, parseJson } from './base';
import { TradeProposal, RiskDecision } from './types';
import { ALLOWED_TOKENS } from '../guardrails';

const SYSTEM_PROMPT = `You are an adversarial risk officer for an autonomous trading agent.
Your job is to PROTECT capital by rejecting or resizing any trade that violates the rules below.
Default to rejection when uncertain. You have NO tools — reason only from the context provided.
Respond ONLY with a JSON object — no markdown, no explanation outside the JSON:
{
  "approved": boolean,
  "finalTrade": { "action": "BUY"|"SELL"|"HOLD", "token": string, "amountBnb": number, "reasoning": string, "confidence": "HIGH"|"MEDIUM"|"LOW" } | null,
  "reason": string
}
If approved, finalTrade may have a reduced amountBnb versus the proposal. If rejected, finalTrade is null.`;

export async function runRiskOfficer(
  proposal: TradeProposal,
  drawdownPct: number,
  todayTradeCount: number,
  maxTradeBnb: number,
): Promise<RiskDecision> {
  if (proposal.action === 'HOLD') {
    return { approved: true, finalTrade: proposal, reason: 'HOLD requires no risk check.' };
  }

  const dailyLimit = parseInt(process.env.DAILY_TRADE_LIMIT ?? '10');
  const drawdownCap = parseFloat(process.env.DRAWDOWN_CAP ?? '0.30');
  const tokenAllowed = ALLOWED_TOKENS.has(proposal.token.toUpperCase());

  const context = `
## Trade Proposal
${JSON.stringify(proposal, null, 2)}

## Risk Rules
- Drawdown cap: ${(drawdownCap * 100).toFixed(0)}% (current drawdown: ${(drawdownPct * 100).toFixed(2)}%)
- Max trade size: ${maxTradeBnb} BNB (proposed: ${proposal.amountBnb} BNB)
- Daily trade limit: ${dailyLimit} (used today: ${todayTradeCount})
- Token on competition allowlist: ${tokenAllowed ? 'YES' : 'NO — MUST REJECT'}

## Your Task
Evaluate the proposal against every rule. If the size is slightly too large, resize it down and approve.
If the token is not on the allowlist, or drawdown cap is breached, or daily limit is reached — reject with a clear reason.
`.trim();

  const raw = await runAgent({
    role: 'RiskOfficer',
    systemPrompt: SYSTEM_PROMPT,
    userMessage: context,
    maxTokens: 512,
  });

  return parseJson<RiskDecision>(raw);
}
