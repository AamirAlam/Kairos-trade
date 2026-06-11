/**
 * Position exit manager — enforces take-profit and stop-loss on open positions.
 * Runs every tick BEFORE the LLM pipeline so winners are banked and losers are
 * cut deterministically, independent of agent reasoning or trading windows.
 */
import { getOpenPositions } from '../db/queries';
import { getTokenPrices } from '../signals/cmc';
import { Position } from '../db/schema';

const TAKE_PROFIT_PCT = parseFloat(process.env.TAKE_PROFIT_PCT ?? '0.06'); // +6%
const STOP_LOSS_PCT   = parseFloat(process.env.STOP_LOSS_PCT   ?? '0.035'); // -3.5%
const MAX_HOLD_HOURS  = parseFloat(process.env.MAX_HOLD_HOURS  ?? '48');    // time stop

export type PositionPnl = {
  position: Position;
  currentPrice: number;
  pnlPct: number;
};

export type ExitSignal = PositionPnl & {
  reason: 'TAKE_PROFIT' | 'STOP_LOSS' | 'TIME_STOP';
};

async function fetchPrices(symbols: string[]): Promise<Record<string, number>> {
  if (symbols.length === 0) return {};
  const quotes = await getTokenPrices(symbols);
  return Object.fromEntries(quotes.map(q => [q.symbol.toUpperCase(), q.price_usd]));
}

/** Open positions enriched with live price and unrealized PnL. */
export async function getOpenPositionsWithPnl(): Promise<PositionPnl[]> {
  const positions = getOpenPositions();
  if (positions.length === 0) return [];

  let prices: Record<string, number> = {};
  try {
    prices = await fetchPrices([...new Set(positions.map(p => p.token))]);
  } catch (err) {
    console.error('[positions] price fetch failed:', err);
    return [];
  }

  return positions.flatMap(pos => {
    const currentPrice = prices[pos.token.toUpperCase()];
    if (!currentPrice || pos.entry_price_usd <= 0) return [];
    const pnlPct = (currentPrice - pos.entry_price_usd) / pos.entry_price_usd;
    return [{ position: pos, currentPrice, pnlPct }];
  });
}

/**
 * Evaluate every open position against TP / SL / time-stop rules.
 * Returns the positions that should be closed this tick, with the reason.
 */
export async function evaluateExits(now: number): Promise<ExitSignal[]> {
  const enriched = await getOpenPositionsWithPnl();

  const exits: ExitSignal[] = [];
  for (const { position, currentPrice, pnlPct } of enriched) {
    const heldHours = (now - position.opened_at) / 3_600_000;

    let reason: ExitSignal['reason'] | null = null;
    if (pnlPct >= TAKE_PROFIT_PCT) reason = 'TAKE_PROFIT';
    else if (pnlPct <= -STOP_LOSS_PCT) reason = 'STOP_LOSS';
    else if (heldHours >= MAX_HOLD_HOURS) reason = 'TIME_STOP';

    if (reason) exits.push({ position, currentPrice, pnlPct, reason });
  }

  return exits;
}

export const EXIT_CONFIG = { TAKE_PROFIT_PCT, STOP_LOSS_PCT, MAX_HOLD_HOURS };
