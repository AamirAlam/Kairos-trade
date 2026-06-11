import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import { getRecentTrades, getPnlHistory, getRecentSignals, getRecentAgentRuns } from '../db/queries';

export type AgentState = {
  status: 'RUNNING' | 'PAUSED' | 'STOPPED';
  portfolioUsd: number;
  startingUsd: number;
  pnlPct: number;
  drawdownPct: number;
  lastUpdated: number;
};

let agentState: AgentState = {
  status: 'STOPPED',
  portfolioUsd: 0,
  startingUsd: 0,
  pnlPct: 0,
  drawdownPct: 0,
  lastUpdated: Date.now(),
};

const clients = new Set<WebSocket>();

export function updateAgentState(patch: Partial<AgentState>) {
  agentState = { ...agentState, ...patch, lastUpdated: Date.now() };
  broadcast({ type: 'state', data: agentState });
}

export function broadcast(msg: object) {
  const payload = JSON.stringify(msg);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

export function createServer(port: number) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get('/api/state', (_req, res) => {
    res.json(agentState);
  });

  app.get('/api/trades', (_req, res) => {
    res.json(getRecentTrades(50));
  });

  app.get('/api/pnl', (_req, res) => {
    res.json(getPnlHistory(168));
  });

  app.get('/api/signals', (_req, res) => {
    res.json(getRecentSignals(20));
  });

  app.get('/api/runs', (_req, res) => {
    const runs = getRecentAgentRuns(50).map(r => ({
      ...r,
      analyst_brief: r.analyst_brief ? JSON.parse(r.analyst_brief) : null,
    }));
    res.json(runs);
  });

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'state', data: agentState }));
    ws.on('close', () => clients.delete(ws));
  });

  server.listen(port, () => {
    console.log(`[api] listening on http://localhost:${port}`);
  });

  return server;
}
