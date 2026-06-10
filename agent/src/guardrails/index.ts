import { AgentState } from '../api/server';

const DRAWDOWN_CAP = parseFloat(process.env.DRAWDOWN_CAP ?? '0.30');
const MAX_TRADE_BNB = parseFloat(process.env.MAX_TRADE_SIZE_BNB ?? '0.5');
const DAILY_LIMIT = parseInt(process.env.DAILY_TRADE_LIMIT ?? '10');

const dailyTradeCount = new Map<string, number>();

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export type GuardrailResult = { allowed: boolean; reason?: string };

export function checkDrawdown(state: AgentState): GuardrailResult {
  if (state.drawdownPct >= DRAWDOWN_CAP) {
    return { allowed: false, reason: `Drawdown ${(state.drawdownPct * 100).toFixed(1)}% exceeds cap ${DRAWDOWN_CAP * 100}%` };
  }
  return { allowed: true };
}

export function checkTradeSize(amountBnb: number): GuardrailResult {
  if (amountBnb > MAX_TRADE_BNB) {
    return { allowed: false, reason: `Trade size ${amountBnb} BNB exceeds max ${MAX_TRADE_BNB} BNB` };
  }
  return { allowed: true };
}

export function checkDailyLimit(): GuardrailResult {
  const key = todayKey();
  const count = dailyTradeCount.get(key) ?? 0;
  if (count >= DAILY_LIMIT) {
    return { allowed: false, reason: `Daily trade limit ${DAILY_LIMIT} reached` };
  }
  return { allowed: true };
}

export function recordTrade() {
  const key = todayKey();
  dailyTradeCount.set(key, (dailyTradeCount.get(key) ?? 0) + 1);
}

export function getDailyTradeCount(): number {
  return dailyTradeCount.get(todayKey()) ?? 0;
}

// Token allowlist — 149 competition-eligible BEP-20 tokens
export const ALLOWED_TOKENS = new Set([
  'ETH', 'USDT', 'USDC', 'XRP', 'TRX', 'DOGE', 'ZEC', 'ADA', 'LINK', 'BCH',
  'DAI', 'TON', 'USD1', 'USDe', 'LTC', 'AVAX', 'SHIB', 'WLFI', 'DOT', 'UNI',
  'ASTER', 'DEXE', 'USDD', 'ETC', 'AAVE', 'ATOM', 'FIL', 'INJ', 'FET', 'TUSD',
  'BONK', 'PENGU', 'CAKE', 'SIREN', 'LUNC', 'ZRO', 'KITE', 'FDUSD', 'BEAT',
  'BTT', 'NFT', 'EDGE', 'FLOKI', 'LDO', 'PENDLE', 'NEX', 'STG', 'AXS', 'TWT',
  'RAY', 'COMP', 'GWEI', 'XCN', 'GENIUS', 'BAT', 'APE', 'IP', 'SFP', '1INCH',
  'CHEEMS', 'BANANAS31', 'MYX', 'RAVE', 'SNX', 'FORM', 'LAB', 'HTX', 'CTM',
  'FRAX', 'GOMINING', 'BEAM', 'AIOZ', 'ZIG', 'YFI', 'TAC', 'ZETA', 'ROSE',
  'VELO', 'BRETT', 'OPEN', 'ACH', 'AXL', 'ELF', 'KAVA', 'IRYS', 'SUSHI',
  'PEAQ', 'COAI', 'CAKE', 'DUSK',
]);

export function checkTokenAllowed(symbol: string): GuardrailResult {
  if (!ALLOWED_TOKENS.has(symbol.toUpperCase())) {
    return { allowed: false, reason: `Token ${symbol} not on competition allowlist` };
  }
  return { allowed: true };
}
