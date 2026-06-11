import { runAnalyst } from './analyst';
import { runPortfolioManager, OpenPositionSummary } from './portfolioManager';
import { runRiskOfficer } from './riskOfficer';
import { evaluateExits, getOpenPositionsWithPnl } from './exitManager';
import { AgentRunResult, MarketBrief } from './types';
import { executeTrade } from '../execution';
import {
  insertTrade, updateTradeStatus, insertSignalLog, insertAgentRun,
  openPosition, closePosition, getOpenPositionByToken,
} from '../db/queries';
import { recordTrade, getDailyTradeCount, checkTradingWindow, isInTradingWindow } from '../guardrails';
import { getTokenPrices } from '../signals/cmc';
import { broadcast, updateAgentState } from '../api/server';

const REQUIRE_HIGH_CONFIDENCE = (process.env.REQUIRE_HIGH_CONFIDENCE ?? 'true') === 'true';

// ── Small helpers to keep persistence + broadcast in one place ──────────────

function recordRun(r: {
  action: string;
  token: string;
  marketBrief: MarketBrief | null;
  pmReasoning: string | null;
  riskReasoning: string | null;
  tradeId: number | null;
}) {
  const ts = Date.now();
  const id = insertAgentRun({
    timestamp: ts,
    action: r.action,
    token: r.token,
    analyst_brief: r.marketBrief ? JSON.stringify(r.marketBrief) : null,
    pm_reasoning: r.pmReasoning,
    risk_reasoning: r.riskReasoning,
    trade_id: r.tradeId,
  });
  broadcast({
    type: 'run',
    data: {
      id, timestamp: ts, action: r.action, token: r.token,
      analyst_brief: r.marketBrief, pm_reasoning: r.pmReasoning,
      risk_reasoning: r.riskReasoning, trade_id: r.tradeId,
    },
  });
  return id;
}

function recordTradeRow(t: {
  token: string;
  side: 'BUY' | 'SELL';
  amountBnb: number;
  signal: string;
  marketBrief: MarketBrief | null;
  pmReasoning: string | null;
  riskReasoning: string | null;
}): number {
  return insertTrade({
    timestamp: Date.now(),
    token: t.token,
    side: t.side,
    amount_bnb: t.amountBnb,
    price_usd: 0,
    tx_hash: null,
    signal: t.signal,
    status: 'PENDING',
    analyst_brief: t.marketBrief?.summary ?? null,
    pm_reasoning: t.pmReasoning,
    risk_reasoning: t.riskReasoning,
  });
}

function broadcastTrade(tradeId: number, token: string, side: string, amountBnb: number, txHash: string | null, status: string, signal: string) {
  broadcast({
    type: 'trade',
    data: {
      id: tradeId, timestamp: Date.now(), token, side,
      amount_bnb: amountBnb, price_usd: 0, tx_hash: txHash, signal, status,
    },
  });
}

// Fetch token + BNB price to compute how many tokens a BNB amount buys.
async function entryPricing(token: string, bnbSpent: number): Promise<{ tokenPriceUsd: number; amountToken: number } | null> {
  try {
    const quotes = await getTokenPrices([token.toUpperCase(), 'BNB']);
    const map = Object.fromEntries(quotes.map(q => [q.symbol.toUpperCase(), q.price_usd]));
    const tokenPriceUsd = map[token.toUpperCase()];
    const bnbPriceUsd = map['BNB'];
    if (!tokenPriceUsd || !bnbPriceUsd) return null;
    const amountToken = (bnbSpent * bnbPriceUsd) / tokenPriceUsd;
    return { tokenPriceUsd, amountToken };
  } catch (err) {
    console.error('[orchestrator] entry pricing failed:', err);
    return null;
  }
}

// ── PHASE 0: deterministic exit management (runs every tick, ignores window) ──

async function processExits() {
  let exits;
  try {
    exits = await evaluateExits(Date.now());
  } catch (err) {
    console.error('[orchestrator] exit evaluation failed:', err);
    return;
  }
  if (exits.length === 0) return;

  for (const exit of exits) {
    const pos = exit.position;
    const pnlStr = `${exit.pnlPct >= 0 ? '+' : ''}${(exit.pnlPct * 100).toFixed(2)}%`;
    const reasonText = `${exit.reason} hit on ${pos.token}: ${pnlStr} (entry $${pos.entry_price_usd.toPrecision(4)} → $${exit.currentPrice.toPrecision(4)})`;
    console.log(`[orchestrator] EXIT ${reasonText}`);

    const signal = `[Exit] ${reasonText}`;
    const tradeId = recordTradeRow({
      token: pos.token, side: 'SELL', amountBnb: pos.amount_token,
      signal, marketBrief: null, pmReasoning: 'Automated exit (TP/SL/time-stop)',
      riskReasoning: reasonText,
    });

    const result = await executeTrade({
      token: pos.token, side: 'SELL', amountBnb: pos.amount_token, signal,
    });

    updateTradeStatus(tradeId, result.status, result.txHash ?? undefined);
    recordTrade();

    closePosition(pos.id, {
      closed_at: Date.now(),
      exit_price_usd: exit.currentPrice,
      exit_reason: exit.reason,
      realized_pnl_pct: exit.pnlPct,
      close_trade_id: tradeId,
    });

    recordRun({
      action: exit.reason, token: pos.token, marketBrief: null,
      pmReasoning: 'Automated exit (TP/SL/time-stop)', riskReasoning: reasonText,
      tradeId,
    });
    broadcastTrade(tradeId, pos.token, 'SELL', pos.amount_token, result.txHash, result.status, signal);
  }
}

export async function runOrchestrator(state: {
  portfolioUsd: number;
  bnbBalance: number;
  maxTradeBnb: number;
  drawdownPct: number;
}): Promise<AgentRunResult | null> {
  console.log('[orchestrator] starting agent pipeline');

  // ── PHASE 0: Exit management (LLM-free, always runs) ─────────────────────────
  await processExits();

  // ── Window gate: skip the entire LLM pipeline outside trading windows ────────
  // No new entry can open outside a window, so running the Analyst/PM/Risk agents
  // there would burn tokens for nothing. Exits above already ran.
  if (!isInTradingWindow()) {
    const reason = checkTradingWindow().reason ?? 'Outside trading window';
    console.log(`[orchestrator] ${reason} — skipping LLM pipeline (exits only)`);
    return null;
  }

  // ── Agent 1: Analyst ────────────────────────────────────────────────────────
  console.log('[orchestrator] → Analyst');
  let marketBrief: MarketBrief;
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

  // ── Agent 2: Portfolio Manager (position-aware) ──────────────────────────────
  const enriched = await getOpenPositionsWithPnl();
  const openSummaries: OpenPositionSummary[] = enriched.map(e => ({
    token: e.position.token,
    bnbSpent: e.position.bnb_spent,
    entryPriceUsd: e.position.entry_price_usd,
    currentPriceUsd: e.currentPrice,
    unrealizedPnlPct: e.pnlPct,
  }));

  console.log('[orchestrator] → Portfolio Manager');
  let proposal;
  try {
    proposal = await runPortfolioManager(marketBrief, state.portfolioUsd, state.bnbBalance, state.maxTradeBnb, openSummaries);
  } catch (err) {
    console.error('[orchestrator] Portfolio Manager failed:', err);
    return null;
  }
  console.log(`[orchestrator] ← Portfolio Manager: ${proposal.action} ${proposal.token} ${proposal.amountBnb} BNB (${proposal.confidence})`);
  broadcast({ type: 'agent', agent: 'portfolioManager', data: proposal });

  const holdResult = (reason: string): AgentRunResult => ({
    marketBrief, proposal, riskDecision: { approved: true, finalTrade: proposal, reason },
  });

  if (proposal.action === 'HOLD') {
    console.log('[orchestrator] HOLD — no trade');
    broadcast({ type: 'agent', agent: 'riskOfficer', data: { approved: true, reason: 'HOLD — no trade needed.' } });
    recordRun({ action: 'HOLD', token: proposal.token || '', marketBrief, pmReasoning: proposal.reasoning, riskReasoning: 'HOLD — no risk check performed.', tradeId: null });
    return holdResult('HOLD');
  }

  // ── Pre-execution gates for NEW entries ──────────────────────────────────────
  const isBuy = proposal.action === 'BUY';

  // No pyramiding — refuse to add to an existing open position.
  if (isBuy && getOpenPositionByToken(proposal.token)) {
    const reason = `Already holding ${proposal.token} — no pyramiding.`;
    console.log(`[orchestrator] SKIP: ${reason}`);
    recordRun({ action: 'SKIPPED', token: proposal.token, marketBrief, pmReasoning: proposal.reasoning, riskReasoning: reason, tradeId: null });
    return holdResult(reason);
  }

  // HIGH-confidence gate for new BUYs (exits/SELLs are never gated here).
  if (isBuy && REQUIRE_HIGH_CONFIDENCE && proposal.confidence !== 'HIGH') {
    const reason = `Confidence ${proposal.confidence} below HIGH threshold — entry skipped.`;
    console.log(`[orchestrator] SKIP: ${reason}`);
    recordRun({ action: 'SKIPPED', token: proposal.token, marketBrief, pmReasoning: proposal.reasoning, riskReasoning: reason, tradeId: null });
    return holdResult(reason);
  }

  // (Trading-window gate already enforced at the top of the pipeline.)

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
    recordRun({ action: 'VETOED', token: proposal.token, marketBrief, pmReasoning: proposal.reasoning, riskReasoning: riskDecision.reason, tradeId: null });
    return { marketBrief, proposal, riskDecision };
  }

  // ── Execute ──────────────────────────────────────────────────────────────────
  const trade = riskDecision.finalTrade;
  const side = trade.action as 'BUY' | 'SELL';
  const reasoning = `[Analyst] ${marketBrief.summary} | [PM] ${proposal.reasoning} | [Risk] ${riskDecision.reason}`;

  // For a BUY, lock in entry pricing BEFORE executing so we can open the position.
  let pricing: { tokenPriceUsd: number; amountToken: number } | null = null;
  if (side === 'BUY') {
    pricing = await entryPricing(trade.token, trade.amountBnb);
    if (!pricing) {
      const reason = `Could not price ${trade.token} for entry — aborting BUY.`;
      console.warn(`[orchestrator] ${reason}`);
      recordRun({ action: 'SKIPPED', token: trade.token, marketBrief, pmReasoning: proposal.reasoning, riskReasoning: reason, tradeId: null });
      return { marketBrief, proposal, riskDecision: { ...riskDecision, reason } };
    }
  }

  const tradeId = recordTradeRow({
    token: trade.token, side, amountBnb: trade.amountBnb, signal: reasoning,
    marketBrief, pmReasoning: proposal.reasoning, riskReasoning: riskDecision.reason,
  });

  // For a SELL closing a held position, sell the tracked token amount.
  const heldPosition = side === 'SELL' ? getOpenPositionByToken(trade.token) : null;
  const sellAmount = heldPosition ? heldPosition.amount_token : trade.amountBnb;

  const result = await executeTrade({
    token: trade.token, side, amountBnb: side === 'SELL' ? sellAmount : trade.amountBnb, signal: reasoning,
  });

  updateTradeStatus(tradeId, result.status, result.txHash ?? undefined);
  recordTrade();

  // Position bookkeeping.
  if (result.status === 'CONFIRMED') {
    if (side === 'BUY' && pricing) {
      openPosition({
        token: trade.token, bnb_spent: trade.amountBnb, amount_token: pricing.amountToken,
        entry_price_usd: pricing.tokenPriceUsd, opened_at: Date.now(), open_trade_id: tradeId,
      });
      console.log(`[orchestrator] opened position: ${trade.token} ${pricing.amountToken.toPrecision(4)} @ $${pricing.tokenPriceUsd.toPrecision(4)}`);
    } else if (side === 'SELL' && heldPosition) {
      const exitPrice = (await entryPricing(trade.token, 0))?.tokenPriceUsd ?? heldPosition.entry_price_usd;
      const pnlPct = (exitPrice - heldPosition.entry_price_usd) / heldPosition.entry_price_usd;
      closePosition(heldPosition.id, {
        closed_at: Date.now(), exit_price_usd: exitPrice, exit_reason: 'PM_SELL',
        realized_pnl_pct: pnlPct, close_trade_id: tradeId,
      });
      console.log(`[orchestrator] closed position: ${trade.token} pnl=${(pnlPct * 100).toFixed(2)}%`);
    }
  }

  recordRun({
    action: trade.action, token: trade.token, marketBrief,
    pmReasoning: proposal.reasoning, riskReasoning: riskDecision.reason, tradeId,
  });

  updateAgentState({ portfolioUsd: state.portfolioUsd, drawdownPct: state.drawdownPct });
  broadcastTrade(tradeId, trade.token, trade.action, trade.amountBnb, result.txHash, result.status, reasoning);

  console.log(`[orchestrator] trade ${result.status}: ${trade.action} ${trade.token} tx=${result.txHash}`);
  return { marketBrief, proposal, riskDecision };
}
