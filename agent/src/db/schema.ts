import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'agent.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    _db = new DatabaseSync(DB_PATH);
    migrate(_db);
  }
  return _db;
}

function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       INTEGER NOT NULL,
      token           TEXT NOT NULL,
      side            TEXT NOT NULL CHECK(side IN ('BUY', 'SELL')),
      amount_bnb      REAL NOT NULL,
      price_usd       REAL NOT NULL,
      tx_hash         TEXT,
      signal          TEXT,
      status          TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'CONFIRMED', 'FAILED')),
      analyst_brief   TEXT,
      pm_reasoning    TEXT,
      risk_reasoning  TEXT
    );

    CREATE TABLE IF NOT EXISTS pnl_snapshots (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp       INTEGER NOT NULL,
      portfolio_usd   REAL NOT NULL,
      pnl_pct         REAL NOT NULL,
      drawdown_pct    REAL NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     INTEGER NOT NULL,
      fear_greed    INTEGER,
      funding_rate  REAL,
      sentiment     TEXT,
      regime        TEXT NOT NULL,
      action        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp      INTEGER NOT NULL,
      action         TEXT NOT NULL,
      token          TEXT NOT NULL DEFAULT '',
      analyst_brief  TEXT,
      pm_reasoning   TEXT,
      risk_reasoning TEXT,
      trade_id       INTEGER REFERENCES trades(id)
    );
  `);

  // Non-destructive migrations for existing databases
  const tradeCols = (db.prepare(`PRAGMA table_info(trades)`).all() as { name: string }[]).map(r => r.name);
  if (!tradeCols.includes('analyst_brief'))  db.exec(`ALTER TABLE trades ADD COLUMN analyst_brief  TEXT`);
  if (!tradeCols.includes('pm_reasoning'))   db.exec(`ALTER TABLE trades ADD COLUMN pm_reasoning   TEXT`);
  if (!tradeCols.includes('risk_reasoning')) db.exec(`ALTER TABLE trades ADD COLUMN risk_reasoning TEXT`);
}

export type Trade = {
  id: number;
  timestamp: number;
  token: string;
  side: 'BUY' | 'SELL';
  amount_bnb: number;
  price_usd: number;
  tx_hash: string | null;
  signal: string | null;
  status: 'PENDING' | 'CONFIRMED' | 'FAILED';
  analyst_brief: string | null;
  pm_reasoning: string | null;
  risk_reasoning: string | null;
};

export type PnlSnapshot = {
  id: number;
  timestamp: number;
  portfolio_usd: number;
  pnl_pct: number;
  drawdown_pct: number;
};

export type SignalLog = {
  id: number;
  timestamp: number;
  fear_greed: number | null;
  funding_rate: number | null;
  sentiment: string | null;
  regime: string;
  action: string;
};

export type AgentRun = {
  id: number;
  timestamp: number;
  action: string;
  token: string;
  analyst_brief: string | null;
  pm_reasoning: string | null;
  risk_reasoning: string | null;
  trade_id: number | null;
};
