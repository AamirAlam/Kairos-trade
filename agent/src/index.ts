import 'dotenv/config';
import cron from 'node-cron';
import { createServer, updateAgentState } from './api/server';
import { runOrchestrator } from './agents/orchestrator';
import { insertPnlSnapshot } from './db/queries';
import { getWalletBalance } from './execution';

const PORT = parseInt(process.env.PORT ?? '3001');
const TRADE_PCT = parseFloat(process.env.TRADE_PCT ?? '0.10'); // 10% of BNB balance per trade

let agentState = {
  portfolioUsd: 0,
  bnbBalance: 0,
  startingUsd: 0,
  peakUsd: 0,
  drawdownPct: 0,
  pnlPct: 0,
};

async function tick() {
  console.log(`\n[agent] ── tick ${new Date().toISOString()} ──`);
  const maxTradeBnb = parseFloat((agentState.bnbBalance * TRADE_PCT).toFixed(4));
  console.log(`[agent] BNB balance: ${agentState.bnbBalance} | max trade (${TRADE_PCT * 100}%): ${maxTradeBnb} BNB`);
  await runOrchestrator({
    portfolioUsd: agentState.portfolioUsd,
    bnbBalance: agentState.bnbBalance,
    maxTradeBnb,
    drawdownPct: agentState.drawdownPct,
  });
}

async function pnlSnapshot() {
  const { bnb: bnbBalance, totalUsd: portfolioUsd } = await getWalletBalance();

  if (agentState.startingUsd === 0) {
    agentState.startingUsd = portfolioUsd;
    agentState.peakUsd = portfolioUsd;
    console.log(`[agent] starting portfolio value: $${portfolioUsd.toFixed(2)}`);
  }

  const pnlPct = agentState.startingUsd > 0
    ? (portfolioUsd - agentState.startingUsd) / agentState.startingUsd
    : 0;

  const peakUsd = Math.max(agentState.peakUsd, portfolioUsd);
  const drawdownPct = peakUsd > 0 && portfolioUsd < peakUsd
    ? (peakUsd - portfolioUsd) / peakUsd
    : 0;

  agentState = { ...agentState, portfolioUsd, bnbBalance, pnlPct, peakUsd, drawdownPct };

  insertPnlSnapshot({ timestamp: Date.now(), portfolio_usd: portfolioUsd, pnl_pct: pnlPct, drawdown_pct: drawdownPct });
  updateAgentState({ status: 'RUNNING', portfolioUsd, startingUsd: agentState.startingUsd, pnlPct, drawdownPct });

  console.log(`[agent] snapshot: ${bnbBalance.toFixed(4)} BNB | $${portfolioUsd.toFixed(2)} | pnl=${(pnlPct * 100).toFixed(2)}% | dd=${(drawdownPct * 100).toFixed(2)}%`);
}

async function main() {
  createServer(PORT);
  updateAgentState({ status: 'RUNNING' });
  console.log('[agent] starting — 3-agent pipeline, tick every 15 min (LLM pipeline gated to trading windows)');

  await pnlSnapshot();
  await tick();

  cron.schedule('*/15 * * * *', tick);
  cron.schedule('0 * * * *', pnlSnapshot);
}

main().catch(err => {
  console.error('[agent] fatal:', err);
  process.exit(1);
});
