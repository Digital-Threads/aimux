import { createInterface } from 'node:readline';
import type { AimuxData } from './dashboard.js';

const TOOLS = [
  {
    name: 'aimux_limits',
    description:
      'How full every aimux subscription is right now: percent of the 5-hour and weekly windows used, when each resets, '
      + 'a pace verdict per window (ok, tight, over = runs out before the reset, spent), the projected level at the reset, '
      + 'and `freest`, the subscription with the most room.',
    inputSchema: {
      type: 'object',
      properties: { fresh: { type: 'boolean', description: 'Read the limits again now instead of reusing a reading a few minutes old.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aimux_usage',
    description:
      'Where the tokens went in a time window: per profile, model and project, plus the heaviest sessions '
      + '(input, cache write, cache read, output, requests, list-price cost estimate in USD). The first call on a machine can take a minute.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: "'all', or a duration such as 24h, 7d, 4w. Default 7d." },
        days: { type: 'boolean', description: 'Also return the split by day and profile (by hour for up to 48h). Long for wide windows.' },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'aimux_limits_history',
    description: 'Past readings of every subscription\'s limits, oldest first: `[5-hour %, weekly %]` per profile, to see how fast they fill.',
    inputSchema: {
      type: 'object',
      properties: { hours: { type: 'number', description: 'How far back to look. Default 24.' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

// The protocol revisions this server speaks, newest first.
const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

async function callTool(name: unknown, args: Record<string, unknown>, data: AimuxData): Promise<unknown> {
  if (name === 'aimux_limits') return data.limits(args.fresh === true);
  if (name === 'aimux_limits_history') return data.history(typeof args.hours === 'number' ? args.hours : 24);

  if (name === 'aimux_usage') {
    const { days, buckets, ...rest } = await data.usage(typeof args.since === 'string' ? args.since : '7d');
    return args.days === true ? { ...rest, days, buckets } : rest;
  }

  throw Object.assign(new Error(`Unknown tool: ${String(name)}`), { code: -32602 });
}

/**
 * The reply to one MCP message (JSON-RPC over stdio), or nothing for a notification.
 * A tool that fails answers with `isError`, so the client reads why instead of a broken call.
 */
export async function mcpReply(message: any, data: AimuxData, version: string): Promise<object | null> {
  // A batch is not answered item by item here; say so rather than leave the client waiting.
  if (Array.isArray(message)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Batches are not supported: send one request at a time' } };

  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return null;

  const reply = (body: object) => ({ jsonrpc: '2.0', id, ...body });

  switch (method) {
    case 'initialize':
      return reply({
        result: {
          // The client's revision when this server speaks it, else the newest it does.
          protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'aimux', version },
        },
      });
    case 'ping':
      return reply({ result: {} });
    case 'tools/list':
      return reply({ result: { tools: TOOLS } });
    case 'tools/call':
      try {
        const found = await callTool(params?.name, params?.arguments ?? {}, data);
        return reply({ result: { content: [{ type: 'text', text: JSON.stringify(found) }] } });
      } catch (err) {
        const { code, message: why } = err as Error & { code?: number };
        if (typeof code === 'number') return reply({ error: { code, message: why } });

        return reply({ result: { isError: true, content: [{ type: 'text', text: why }] } });
      }
    default:
      return reply({ error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
}

/** Serve MCP on stdin/stdout, one JSON message a line, until the client closes the pipe. */
export function serveMcp(data: AimuxData, version: string): void {
  const send = (body: object) => process.stdout.write(`${JSON.stringify(body)}\n`);

  createInterface({ input: process.stdin }).on('line', (line) => {
    if (!line.trim()) return;

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    void mcpReply(message, data, version).then((body) => body && send(body));
  });
}
