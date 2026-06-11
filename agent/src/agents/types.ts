export type MarketBrief = {
  regime: 'BULL' | 'BEAR' | 'NEUTRAL';
  fearGreed: number;
  fearGreedLabel: string;
  fundingRate: number | null;
  sentiment: string | null;
  topOpportunities: string[];
  keyRisks: string[];
  summary: string;
};

export type TradeProposal = {
  action: 'BUY' | 'SELL' | 'HOLD';
  token: string;
  amountBnb: number;
  reasoning: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
};

export type RiskDecision = {
  approved: boolean;
  finalTrade: TradeProposal | null;
  reason: string;
};

export type AgentRunResult = {
  marketBrief: MarketBrief;
  proposal: TradeProposal;
  riskDecision: RiskDecision;
};
