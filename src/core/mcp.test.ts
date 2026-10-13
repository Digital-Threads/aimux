import { describe, it, expect } from 'vitest';
import type { AimuxData, UsageWindow } from './dashboard.js';
import { mcpReply } from './mcp.js';

const data: AimuxData = {
  limits: async (fresh) => ({ fetchedAt: fresh ? 2 : 1, now: 3, profiles: [], freest: 'dt', order: ['dt'] }),
  usage: async (since) => {
    if (since === 'bad') throw new Error("since takes 'all' or a duration like 24h");
    return { since, hourly: false, computedAt: 1, profiles: [], days: [{ day: '2026-05-14' }], buckets: ['2026-05-14'], models: [], projects: [], sessions: [] } as unknown as UsageWindow;
  },
  history: (hours) => [{ at: hours, profiles: {} }],
};

const call = async (name: string, args: object = {}) => {
  const reply = (await mcpReply({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } }, data, '1.2.3')) as any;
  return reply.result?.isError ? reply.result : reply.result ? JSON.parse(reply.result.content[0].text) : reply;
};

describe('mcpReply', () => {
  it('answers a revision it does not speak with the newest it does, and a batch with a refusal', async () => {
    const reply = (await mcpReply({ id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, data, '1')) as any;
    expect(reply.result.protocolVersion).toBe('2025-06-18');

    expect(await mcpReply([{ id: 1, method: 'ping' }], data, '1')).toMatchObject({ id: null, error: { code: -32600 } });
  });

  it('introduces itself with the protocol version the client speaks', async () => {
    expect(await mcpReply({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, data, '1.2.3')).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'aimux', version: '1.2.3' } },
    });
  });

  it('lists its tools, all read-only', async () => {
    const reply = (await mcpReply({ id: 2, method: 'tools/list' }, data, '1')) as any;

    expect(reply.result.tools.map((t: any) => t.name)).toEqual(['aimux_limits', 'aimux_usage', 'aimux_limits_history']);
    expect(reply.result.tools.every((t: any) => t.annotations.readOnlyHint && t.inputSchema.type === 'object')).toBe(true);
  });

  it('answers a notification with nothing', async () => {
    expect(await mcpReply({ method: 'notifications/initialized' }, data, '1')).toBeNull();
  });

  it('reads the limits, fresh when asked', async () => {
    expect(await call('aimux_limits')).toMatchObject({ fetchedAt: 1, freest: 'dt' });
    expect(await call('aimux_limits', { fresh: true })).toMatchObject({ fetchedAt: 2 });
  });

  it('reads the usage for a week by default, the split by day only on request', async () => {
    expect(await call('aimux_usage')).toMatchObject({ since: '7d' });
    expect(await call('aimux_usage')).not.toHaveProperty('days');
    expect(await call('aimux_usage')).not.toHaveProperty('buckets');
    expect(await call('aimux_usage', { since: '24h', days: true })).toMatchObject({ since: '24h', days: [{ day: '2026-05-14' }], buckets: ['2026-05-14'] });
  });

  it('reads the history for a day by default', async () => {
    expect(await call('aimux_limits_history')).toEqual([{ at: 24, profiles: {} }]);
    expect(await call('aimux_limits_history', { hours: 72 })).toEqual([{ at: 72, profiles: {} }]);
  });

  it('says why a tool failed, in a reply the client can read', async () => {
    expect(await call('aimux_usage', { since: 'bad' })).toEqual({ isError: true, content: [{ type: 'text', text: "since takes 'all' or a duration like 24h" }] });
  });

  it('refuses a tool or a method it does not have', async () => {
    expect(await call('aimux_delete_everything')).toMatchObject({ error: { code: -32602 } });
    expect(await mcpReply({ id: 3, method: 'resources/list' }, data, '1')).toMatchObject({ error: { code: -32601 } });
  });
});
