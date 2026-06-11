/**
 * On-chain net worth — twak's balance/portfolio endpoints only return the native
 * BNB balance (token holdings come back empty), so we read BEP-20 balances directly
 * from chain via JSON-RPC eth_call and price them through CoinMarketCap. This matches
 * what a block explorer shows.
 *
 * Note: BSC BEP-20 tokens are uniformly 18 decimals (including USDT/USDC, unlike on
 * Ethereum), so we treat all balances as 18-decimal. Stablecoins are valued via CMC.
 */
import { BSC_TOKENS } from './tokens';
import { getTokenPrices } from '../signals/cmc';

const RPC_URL = process.env.BSC_RPC_URL ?? 'https://bsc-dataseed1.binance.org';
const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

export type TokenHolding = {
  symbol: string;
  amount: number;
  priceUsd: number;
  valueUsd: number;
};

// Distinct symbol→address pairs (the registry has a couple of aliases sharing an address).
function tokenEntries(): { symbol: string; address: string }[] {
  const seen = new Set<string>();
  const out: { symbol: string; address: string }[] = [];
  for (const [symbol, address] of Object.entries(BSC_TOKENS)) {
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ symbol, address });
  }
  return out;
}

async function ethCall(to: string, data: string): Promise<string> {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_call',
      params: [{ to, data }, 'latest'],
    }),
  });
  const json = await res.json() as { result?: string; error?: { message: string } };
  if (json.error) throw new Error(json.error.message);
  return json.result ?? '0x0';
}

async function balanceOf(token: string, owner: string): Promise<bigint> {
  const padded = owner.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const raw = await ethCall(token, BALANCE_OF_SELECTOR + padded);
  if (!raw || raw === '0x') return 0n;
  return BigInt(raw);
}

function toAmount(raw: bigint): number {
  // raw / 10^18 with float precision good enough for USD valuation
  return Number(raw) / 1e18;
}

/**
 * Read non-zero BEP-20 balances for `owner` across the token registry and value them.
 * Returns priced holdings (tokens we couldn't price are dropped from the USD total).
 */
export async function getTokenHoldings(owner: string): Promise<TokenHolding[]> {
  const entries = tokenEntries();

  const balances = await Promise.all(
    entries.map(async e => {
      try {
        return { symbol: e.symbol, raw: await balanceOf(e.address, owner) };
      } catch {
        return { symbol: e.symbol, raw: 0n };
      }
    }),
  );

  const held = balances
    .filter(b => b.raw > 0n)
    .map(b => ({ symbol: b.symbol, amount: toAmount(b.raw) }));

  if (held.length === 0) return [];

  let priceMap: Record<string, number> = {};
  try {
    const quotes = await getTokenPrices(held.map(h => h.symbol));
    priceMap = Object.fromEntries(quotes.map(q => [q.symbol.toUpperCase(), q.price_usd]));
  } catch (err) {
    console.error('[networth] price fetch failed:', err);
  }

  return held.flatMap(h => {
    const priceUsd = priceMap[h.symbol.toUpperCase()];
    if (!priceUsd) return [];
    return [{ symbol: h.symbol, amount: h.amount, priceUsd, valueUsd: h.amount * priceUsd }];
  });
}
