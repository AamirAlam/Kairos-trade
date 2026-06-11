import { getDb, Trade, PnlSnapshot, SignalLog, AgentRun, Position } from './schema';

export function insertTrade(trade: Omit<Trade, 'id'>): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO trades
      (timestamp, token, side, amount_bnb, price_usd, tx_hash, signal, status,
       analyst_brief, pm_reasoning, risk_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    trade.timestamp, trade.token, trade.side,
    trade.amount_bnb, trade.price_usd, trade.tx_hash,
    trade.signal, trade.status,
    trade.analyst_brief ?? null, trade.pm_reasoning ?? null, trade.risk_reasoning ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function updateTradeStatus(id: number, status: Trade['status'], tx_hash?: string) {
  getDb()
    .prepare(`UPDATE trades SET status = ?, tx_hash = COALESCE(?, tx_hash) WHERE id = ?`)
    .run(status, tx_hash ?? null, id);
}

export function getRecentTrades(limit = 50): Trade[] {
  return getDb()
    .prepare(`SELECT * FROM trades ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as Trade[];
}

export function insertPnlSnapshot(snap: Omit<PnlSnapshot, 'id'>) {
  getDb().prepare(`
    INSERT INTO pnl_snapshots (timestamp, portfolio_usd, pnl_pct, drawdown_pct)
    VALUES (?, ?, ?, ?)
  `).run(snap.timestamp, snap.portfolio_usd, snap.pnl_pct, snap.drawdown_pct);
}

export function getPnlHistory(limit = 168): PnlSnapshot[] {
  return getDb()
    .prepare(`SELECT * FROM pnl_snapshots ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as PnlSnapshot[];
}

export function insertSignalLog(log: Omit<SignalLog, 'id'>) {
  getDb().prepare(`
    INSERT INTO signal_log (timestamp, fear_greed, funding_rate, sentiment, regime, action)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    log.timestamp, log.fear_greed ?? null, log.funding_rate ?? null,
    log.sentiment ?? null, log.regime, log.action,
  );
}

export function getRecentSignals(limit = 20): SignalLog[] {
  return getDb()
    .prepare(`SELECT * FROM signal_log ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as SignalLog[];
}

export function insertAgentRun(run: Omit<AgentRun, 'id'>): number {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO agent_runs (timestamp, action, token, analyst_brief, pm_reasoning, risk_reasoning, trade_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    run.timestamp, run.action, run.token,
    run.analyst_brief ?? null, run.pm_reasoning ?? null, run.risk_reasoning ?? null,
    run.trade_id ?? null,
  );
  return Number(result.lastInsertRowid);
}

export function getRecentAgentRuns(limit = 20): AgentRun[] {
  return getDb()
    .prepare(`SELECT * FROM agent_runs ORDER BY timestamp DESC LIMIT ?`)
    .all(limit) as AgentRun[];
}

// ── Positions ──────────────────────────────────────────────────────────────

export function openPosition(p: {
  token: string;
  bnb_spent: number;
  amount_token: number;
  entry_price_usd: number;
  opened_at: number;
  open_trade_id: number | null;
}): number {
  const result = getDb().prepare(`
    INSERT INTO positions (token, bnb_spent, amount_token, entry_price_usd, opened_at, status, open_trade_id)
    VALUES (?, ?, ?, ?, ?, 'OPEN', ?)
  `).run(p.token.toUpperCase(), p.bnb_spent, p.amount_token, p.entry_price_usd, p.opened_at, p.open_trade_id ?? null);
  return Number(result.lastInsertRowid);
}

export function closePosition(id: number, c: {
  closed_at: number;
  exit_price_usd: number;
  exit_reason: string;
  realized_pnl_pct: number;
  close_trade_id: number | null;
}) {
  getDb().prepare(`
    UPDATE positions
    SET status = 'CLOSED', closed_at = ?, exit_price_usd = ?, exit_reason = ?,
        realized_pnl_pct = ?, close_trade_id = ?
    WHERE id = ?
  `).run(c.closed_at, c.exit_price_usd, c.exit_reason, c.realized_pnl_pct, c.close_trade_id ?? null, id);
}

export function getOpenPositions(): Position[] {
  return getDb()
    .prepare(`SELECT * FROM positions WHERE status = 'OPEN' ORDER BY opened_at ASC`)
    .all() as Position[];
}

export function getOpenPositionByToken(token: string): Position | null {
  return getDb()
    .prepare(`SELECT * FROM positions WHERE status = 'OPEN' AND token = ? ORDER BY opened_at ASC LIMIT 1`)
    .get(token.toUpperCase()) as Position | undefined ?? null;
}

export function getRecentPositions(limit = 50): Position[] {
  return getDb()
    .prepare(`SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?`)
    .all(limit) as Position[];
}
