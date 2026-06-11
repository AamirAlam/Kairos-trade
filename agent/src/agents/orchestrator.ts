import { runAnalyst } from './analyst';
import { runPortfolioManager } from './portfolioManager';
import { runRiskOfficer } from './riskOfficer';
import { AgentRunResult } from './types';
import { executeTrade } from '../execution';
import { insertTrade, updateTradeStatus, insertSignalLog, insertAgentRun } from '../db/queries';
import { recordTrade, getDailyTradeCount } from '../guardrails';
import { broadcast, updateAgentState } from '../api/server';

export async function runOrchestrator(state: {
  portfolioUsd: number;
  bnbBalance: number;
  maxTradeBnb: number;
  drawdownPct: number;
}): Promise<AgentRunResult | null> {
  console.log('[orchestrator] starting agent pipeline');

  // ── Agent 1: Analyst ────────────────────────────────────────────────────────
  console.log('[orchestrator] → Analyst');
  let marketBrief;
  try {
    marketBrief = await runAnalyst();
  } catch (err) {
    console.error('[orchestrator] Analyst failed:', err);
    return null;
  }
  console.log(`[orchestrator] ← Analyst: regime=${marketBrief.regime} F&G=${marketBrief.fearGreed}`);
  broadcast({ type: 'agent', agent: 'analyst', data: marketBrief });

  const signalTs = Date.now();
  insertSignalLog({
    timestamp: signalTs,
    fear_greed: marketBrief.fearGreed,
    funding_rate: marketBrief.fundingRate,
    sentiment: marketBrief.sentiment,
    regime: marketBrief.regime,
    action: marketBrief.summary,
  });
  broadcast({
    type: 'signal',
    data: {
      timestamp: signalTs,
      fear_greed: marketBrief.fearGreed,
      sentiment: marketBrief.sentiment,
      regime: marketBrief.regime,
      action: marketBrief.summary,
    },
  });

  // ── Agent 2: Portfolio Manager ───────────────────────────────────────────────
  console.log('[orchestrator] → Portfolio Manager');
  let proposal;
  try {
    proposal = await runPortfolioManager(marketBrief, state.portfolioUsd, state.bnbBalance, state.maxTradeBnb);
  } catch (err) {
    console.error('[orchestrator] Portfolio Manager failed:', err);
    return null;
  }
  console.log(`[orchestrator] ← Portfolio Manager: ${proposal.action} ${proposal.token} ${proposal.amountBnb} BNB`);
  broadcast({ type: 'agent', agent: 'portfolioManager', data: proposal });

  if (proposal.action === 'HOLD') {
    console.log('[orchestrator] HOLD — skipping risk check and execution');
    broadcast({ type: 'agent', agent: 'riskOfficer', data: { approved: true, reason: 'HOLD — no trade needed.' } });
    const holdRunId = insertAgentRun({
      timestamp: Date.now(),
      action: 'HOLD',
      token: proposal.token || '',
      analyst_brief: JSON.stringify(marketBrief),
      pm_reasoning: proposal.reasoning,
      risk_reasoning: 'HOLD — no risk check performed.',
      trade_id: null,
    });
    broadcast({ type: 'run', data: { id: holdRunId, timestamp: Date.now(), action: 'HOLD', token: proposal.token || '', analyst_brief: marketBrief, pm_reasoning: proposal.reasoning, risk_reasoning: 'HOLD — no risk check performed.', trade_id: null } });
    return { marketBrief, proposal, riskDecision: { approved: true, finalTrade: proposal, reason: 'HOLD' } };
  }

  // ── Agent 3: Risk Officer ────────────────────────────────────────────────────
  console.log('[orchestrator] → Risk Officer');
  let riskDecision;
  try {
    riskDecision = await runRiskOfficer(proposal, state.drawdownPct, getDailyTradeCount(), state.maxTradeBnb);
  } catch (err) {
    console.error('[orchestrator] Risk Officer failed:', err);
    return null;
  }
  console.log(`[orchestrator] ← Risk Officer: approved=${riskDecision.approved} reason="${riskDecision.reason}"`);
  broadcast({ type: 'agent', agent: 'riskOfficer', data: riskDecision });

  if (!riskDecision.approved || !riskDecision.finalTrade) {
    console.warn('[orchestrator] trade vetoed:', riskDecision.reason);
    const vetoRunId = insertAgentRun({
      timestamp: Date.now(),
      action: 'VETOED',
      token: proposal.token,
      analyst_brief: JSON.stringify(marketBrief),
      pm_reasoning: proposal.reasoning,
      risk_reasoning: riskDecision.reason,
      trade_id: null,
    });
    broadcast({ type: 'run', data: { id: vetoRunId, timestamp: Date.now(), action: 'VETOED', token: proposal.token, analyst_brief: marketBrief, pm_reasoning: proposal.reasoning, risk_reasoning: riskDecision.reason, trade_id: null } });
    return { marketBrief, proposal, riskDecision };
  }

  // ── Execute ──────────────────────────────────────────────────────────────────
  const trade = riskDecision.finalTrade;
  const reasoning = `[Analyst] ${marketBrief.summary} | [PM] ${proposal.reasoning} | [Risk] ${riskDecision.reason}`;

  const tradeId = insertTrade({
    timestamp: Date.now(),
    token: trade.token,
    side: trade.action as 'BUY' | 'SELL',
    amount_bnb: trade.amountBnb,
    price_usd: 0,
    tx_hash: null,
    signal: reasoning,
    status: 'PENDING',
    analyst_brief: marketBrief.summary,
    pm_reasoning: proposal.reasoning,
    risk_reasoning: riskDecision.reason,
  });

  const result = await executeTrade({
    token: trade.token,
    side: trade.action as 'BUY' | 'SELL',
    amountBnb: trade.amountBnb,
    signal: reasoning,
  });

  updateTradeStatus(tradeId, result.status, result.txHash ?? undefined);
  recordTrade();
  const tradeRunId = insertAgentRun({
    timestamp: Date.now(),
    action: trade.action,
    token: trade.token,
    analyst_brief: JSON.stringify(marketBrief),
    pm_reasoning: proposal.reasoning,
    risk_reasoning: riskDecision.reason,
    trade_id: tradeId,
  });
  broadcast({ type: 'run', data: { id: tradeRunId, timestamp: Date.now(), action: trade.action, token: trade.token, analyst_brief: marketBrief, pm_reasoning: proposal.reasoning, risk_reasoning: riskDecision.reason, trade_id: tradeId } });

  updateAgentState({
    portfolioUsd: state.portfolioUsd,
    drawdownPct: state.drawdownPct,
  });

  broadcast({
    type: 'trade',
    data: {
      id: tradeId,
      timestamp: Date.now(),
      token: trade.token,
      side: trade.action,
      amount_bnb: trade.amountBnb,
      price_usd: 0,
      tx_hash: result.txHash,
      signal: reasoning,
      status: result.status,
    },
  });

  console.log(`[orchestrator] trade ${result.status}: ${trade.action} ${trade.token} tx=${result.txHash}`);
  return { marketBrief, proposal, riskDecision };
}
