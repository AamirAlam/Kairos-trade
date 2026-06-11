/**
 * Minimal CMC MCP client over Streamable HTTP (JSON-RPC 2.0).
 * No external SDK needed — just fetch + session management.
 */
import Anthropic from '@anthropic-ai/sdk';

const MCP_URL = 'https://mcp.coinmarketcap.com/mcp';

type JsonRpcResponse<T = unknown> = {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
};

type McpTool = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

let _sessionId: string | null = null;
let _idCounter = 1;

function nextId() {
  return _idCounter++;
}

async function mcpPost<T>(method: string, params: unknown = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
    'X-CMC-MCP-API-KEY': process.env.CMC_API_KEY ?? '',
  };
  if (_sessionId) headers['Mcp-Session-Id'] = _sessionId;

  const body = JSON.stringify({ jsonrpc: '2.0', id: nextId(), method, params });
  const res = await fetch(MCP_URL, { method: 'POST', headers, body });

  // Capture session ID from server on initialization
  const sid = res.headers.get('Mcp-Session-Id');
  if (sid) _sessionId = sid;

  if (!res.ok) {
    throw new Error(`[cmc-mcp] HTTP ${res.status}: ${await res.text()}`);
  }

  const contentType = res.headers.get('content-type') ?? '';

  // SSE stream — read until we find the JSON-RPC result event
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    for (const line of text.split('\n')) {
      if (line.startsWith('data:')) {
        try {
          const parsed = JSON.parse(line.slice(5).trim()) as JsonRpcResponse<T>;
          if (parsed.error) throw new Error(`[cmc-mcp] ${parsed.error.message}`);
          if (parsed.result !== undefined) return parsed.result;
        } catch { /* not JSON, skip */ }
      }
    }
    throw new Error('[cmc-mcp] no result in SSE stream');
  }

  const parsed = await res.json() as JsonRpcResponse<T>;
  if (parsed.error) throw new Error(`[cmc-mcp] ${parsed.error.message}`);
  return parsed.result as T;
}

async function ensureInitialized() {
  if (_sessionId) return;

  await mcpPost('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'kairos', version: '1.0.0' },
  });

  // Send initialized notification (no response expected)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'X-CMC-MCP-API-KEY': process.env.CMC_API_KEY ?? '',
  };
  if (_sessionId) headers['Mcp-Session-Id'] = _sessionId;
  await fetch(MCP_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
  });

  console.log('[cmc-mcp] session initialized:', _sessionId);
}

export type CmcMcpTools = {
  tools: Anthropic.Tool[];
  handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>>;
};

export async function getCmcMcpTools(): Promise<CmcMcpTools> {
  await ensureInitialized();

  const { tools } = await mcpPost<{ tools: McpTool[] }>('tools/list', {});

  const anthropicTools: Anthropic.Tool[] = tools.map(t => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: (t.inputSchema ?? { type: 'object', properties: {} }) as Anthropic.Tool['input_schema'],
  }));

  const handlers: Record<string, (input: Record<string, unknown>) => Promise<unknown>> = {};
  for (const t of tools) {
    handlers[t.name] = async (input) => {
      type CallResult = { content: { type: string; text?: string }[] };
      try {
        const result = await mcpPost<CallResult>('tools/call', { name: t.name, arguments: input });
        const textParts = result.content
          .filter(c => c.type === 'text')
          .map(c => c.text ?? '');
        return textParts.length === 1 ? textParts[0] : textParts.join('\n');
      } catch (err) {
        return { error: String(err) };
      }
    };
  }

  return { tools: anthropicTools, handlers };
}
