import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';

export type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;

export async function runAgent(opts: {
  role: string;
  systemPrompt: string;
  userMessage: string;
  tools?: Anthropic.Tool[];
  toolHandlers?: Record<string, ToolHandler>;
  maxTokens?: number;
}): Promise<string> {
  const { systemPrompt, userMessage, tools = [], toolHandlers = {}, maxTokens = 1024, role } = opts;

  // Prompt caching: the system prompt and tool schemas are identical on every
  // round-trip of the tool-use loop (the Analyst makes ~18). Caching this static
  // prefix means each round reuses it at ~10% of the input cost instead of
  // re-processing the full system + 12 tool schemas every time.
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } },
  ];

  const cachedTools: Anthropic.Tool[] | undefined = tools.length
    ? tools.map((t, i) =>
        i === tools.length - 1 ? { ...t, cache_control: { type: 'ephemeral' } } : t,
      )
    : undefined;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  // Rolling cache breakpoint on the growing conversation. We move it to the most
  // recent tool_result block each round so the accumulated context is cached
  // incrementally. (System + tools use 2 breakpoints; this is the 3rd of 4 max.)
  let prevCachedBlock: Anthropic.ToolResultBlockParam | null = null;

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      tools: cachedTools,
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      return textBlock?.text ?? '';
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const handler = toolHandlers[block.name];
        let result: unknown;
        try {
          result = handler
            ? await handler(block.input as Record<string, unknown>)
            : { error: `Unknown tool: ${block.name}` };
        } catch (err) {
          result = { error: String(err) };
        }
        console.log(`[${role}] tool ${block.name} →`, JSON.stringify(result).slice(0, 120));
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      // Advance the rolling cache breakpoint to this round's last result.
      if (prevCachedBlock) delete prevCachedBlock.cache_control;
      const lastBlock = toolResults[toolResults.length - 1];
      if (lastBlock) {
        lastBlock.cache_control = { type: 'ephemeral' };
        prevCachedBlock = lastBlock;
      }

      messages.push({ role: 'user', content: toolResults });
      continue;
    }

    // stop_reason: max_tokens or other
    break;
  }

  throw new Error(`[${role}] agent loop did not terminate cleanly after ${iterations} iterations`);
}

export function parseJson<T>(raw: string): T {
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
  if (!match) throw new Error(`No JSON found in agent response: ${raw.slice(0, 200)}`);
  return JSON.parse(match[1]) as T;
}
