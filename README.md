# BNB AI Trading Agent

Autonomous trading agent built for the **BNB Hack: AI Trading Agent Edition** hackathon.

Three specialised Claude agents — Analyst, Portfolio Manager, Risk Officer — collaborate every 5 minutes to read CMC signals, form a trading thesis, and execute self-custodial trades on BSC via Trust Wallet Agent Kit.

**Agent wallet:** `0x644ae63803121De0fF3628db0B3f588E65759a1d`

---

## Stack

| Layer | Technology |
|---|---|
| AI brain | Claude (Anthropic SDK) — 3 role-based agents |
| Signals | CoinMarketCap Agent Hub — Fear & Greed, funding rates, KOL sentiment |
| Execution | Trust Wallet Agent Kit CLI — local signing, keys never leave device |
| Chain | BNB Smart Chain (BSC) via PancakeSwap |
| Agent runtime | Node.js + TypeScript on VPS |
| Database | SQLite via `node:sqlite` (built into Node 24) |
| Dashboard | Next.js + Tailwind + Recharts, deployed on Vercel |

---

## Multi-agent architecture

Three agents run in a sequential pipeline every 5 minutes. Each has a narrow role, specific tools, and produces a structured output that feeds the next agent.

```
Every 5 min:

  ┌──────────────────────────────────────────────────────────────────────┐
  │  ORCHESTRATOR  (src/agents/orchestrator.ts)                          │
  │  Gathers shared context → chains 3 agents → executes approved trade  │
  └───────────────────────────────┬──────────────────────────────────────┘
                                  │
               ┌──────────────────▼──────────────────┐
               │         AGENT 1: ANALYST             │
               │         src/agents/analyst.ts        │
               │                                      │
               │  Role: read and interpret the market │
               │                                      │
               │  Tools:                              │
               │    get_fear_greed()                  │
               │    get_funding_rates()               │
               │    get_sentiment()                   │
               │    get_token_price()                 │
               │                                      │
               │  Output → MarketBrief                │
               │    { regime, signals,                │
               │      opportunities, risks }          │
               └──────────────────┬──────────────────┘
                                  │ MarketBrief
               ┌──────────────────▼──────────────────┐
               │     AGENT 2: PORTFOLIO MANAGER       │
               │     src/agents/portfolioManager.ts   │
               │                                      │
               │  Role: decide what trade to make     │
               │                                      │
               │  Context in: MarketBrief +           │
               │    current holdings + recent trades  │
               │                                      │
               │  Tools:                              │
               │    get_portfolio()                   │
               │    get_recent_trades()               │
               │    get_swap_quote()                  │
               │                                      │
               │  Output → TradeProposal              │
               │    { action, token, amountBnb,       │
               │      reasoning, confidence }         │
               └──────────────────┬──────────────────┘
                                  │ TradeProposal
               ┌──────────────────▼──────────────────┐
               │       AGENT 3: RISK OFFICER          │
               │       src/agents/riskOfficer.ts      │
               │                                      │
               │  Role: adversarial check — veto or   │
               │    resize any trade that breaks rules │
               │                                      │
               │  Tools: none (pure reasoning)        │
               │                                      │
               │  Rules injected as context:          │
               │    • drawdown cap 30% (DQ gate)      │
               │    • max trade size                  │
               │    • daily trade limit               │
               │    • token allowlist (149 tokens)    │
               │                                      │
               │  Output → RiskDecision               │
               │    { approved, finalTrade, reason }  │
               └──────────────────┬──────────────────┘
                                  │ approved trade
               ┌──────────────────▼──────────────────┐
               │         TWAK EXECUTOR                │
               │         src/execution/               │
               │                                      │
               │  twak swap BNB → TOKEN --chain bsc   │
               │    • signs locally (on-device)       │
               │    • submits tx to BSC               │
               │    • returns tx hash                 │
               └──────────────────┬──────────────────┘
                                  │ tx hash + reasoning
               ┌──────────────────▼──────────────────┐
               │  SQLite + WebSocket broadcast        │
               │  Dashboard shows all 3 agents'       │
               │  reasoning in real time              │
               └─────────────────────────────────────┘
```

---

## Data flow: one full trade cycle

```
[1] ANALYST      CMC tools  ──► F&G=15, Funding=-0.04%, regime=BEAR
                                 "Extreme fear. Funding negative — longs
                                  paying shorts. Bearish signal on CAKE
                                  but social diverging from price."

[2] PORT. MGR    Quote tool ──► "F&G at extremes historically mean-reverts.
                                  Getting quote for small CAKE long."
                                  quote: 0.3% impact → "Acceptable. BUY 0.1 BNB."

[3] RISK OFFICER (no tools) ──► "Drawdown 4% — well within 30% cap.
                                  Size 0.1 BNB within daily limit.
                                  CAKE on allowlist. Approved."

[4] LOG          SQLite     ──► trades(status=PENDING) + reasoning stored

[5] SIGN+SEND    TWAK CLI   ──► twak swap 0.1 BNB CAKE --chain bsc
                                  keys stay local, signed on-device
                                  tx submitted to BSC RPC

[6] CONFIRM      BSC        ──► tx hash returned, status=CONFIRMED

[7] UPDATE       SQLite     ──► trades(status=CONFIRMED, tx_hash=0x...)

[8] BROADCAST    WebSocket  ──► dashboard shows reasoning + trade in real time
```

---

## Why 3 agents instead of 1

| | Single agent | 3-agent pipeline |
|---|---|---|
| Decision quality | Reason across all concerns at once | Each agent focuses on one job |
| Guardrail safety | Easy to skip in complex reasoning | Risk Officer has no execution tools — cannot trade |
| Explainability | One blob of reasoning | 3 separate, readable reasoning chains |
| Demo value | "it traded" | Watch analyst → PM → risk officer think out loud |
| Hackathon fit | Automated bot | Actual multi-agent system |

---

## Repo structure

```
bnb-agent/
├── agent/                  # Node.js agent — runs on VPS
│   ├── src/
│   │   ├── agents/         # 3 Claude agents + orchestrator
│   │   │   ├── orchestrator.ts
│   │   │   ├── analyst.ts
│   │   │   ├── portfolioManager.ts
│   │   │   └── riskOfficer.ts
│   │   ├── signals/        # CMC tools (used by analyst agent)
│   │   ├── guardrails/     # Rules injected into risk officer context
│   │   ├── execution/      # TWAK CLI: local signing + BSC tx submission
│   │   ├── db/             # SQLite: trades, PnL snapshots, signal log
│   │   └── api/            # Express REST + WebSocket server
│   ├── .env.example        # Credential template (copy to .env)
│   └── package.json
├── web/                    # Next.js dashboard — deployed on Vercel
│   ├── app/
│   │   ├── components/     # StatusBar, PnlChart, SignalFeed, TradeLog
│   │   │                   # TradeLog shows per-agent reasoning
│   │   ├── hooks/          # useAgent — WebSocket + REST data hook
│   │   └── page.tsx        # Main dashboard
│   └── package.json
└── package.json            # npm workspaces root
```

---

## Key design decisions

| Decision | Why |
|---|---|
| 3 role-based agents | Mirrors real trading desk structure. Each agent has a narrow job — Analyst can't trade, Risk Officer has no tools. Cleaner reasoning, safer execution. |
| Raw Anthropic SDK, no framework | Full control over the agent loop. Guardrails inject before every TWAK call — one obvious place, impossible to bypass. No hidden LangChain abstraction breaking at 2am. |
| TWAK CLI over raw viem | Keys never touch our code — all signing is on-device. Targets the Best Use of TWAK special prize criteria directly. |
| SQLite over Postgres | Zero infra on VPS — one file, no daemon, plenty fast for this write volume. |
| WebSocket push | Dashboard stays live during trading week. Judges see all 3 agents reasoning in real time during the demo. |
| Cron every 5 min | Frequent enough to catch regime shifts, infrequent enough to stay under CMC rate limits. |

---

