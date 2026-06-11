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

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  let iterations = 0;
  const MAX_ITERATIONS = 10;

  while (iterations++ < MAX_ITERATIONS) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemPrompt,
      tools: tools.length ? tools : undefined,
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
