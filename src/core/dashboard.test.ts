import { describe, it, expect, afterEach, vi } from 'vitest';
import { request } from 'node:http';
import { browserCommand, liveData, startDashboard, type AimuxData, type Dashboard, type UsageWindow } from './dashboard.js';

const usageOf = (since: string) => ({ since, hourly: false, computedAt: 1, profiles: [], days: [], buckets: [], models: [], projects: [], sessions: [] }) as UsageWindow;

function fakeData(over: Partial<AimuxData> = {}): AimuxData {
  return {
    limits: async (fresh) => ({ fetchedAt: fresh ? 2 : 1, now: 3, profiles: [], freest: null, order: ['main'] }),
    usage: async (since) => usageOf(since),
    history: (hours) => [{ at: hours, profiles: {} }],
    ...over,
  };
}

/** A GET with the Host header a caller chooses: `fetch` does not let one be set. */
function get(port: number, path: string, host = `localhost:${port}`, method = 'GET', headers: Record<string, string> = {}): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host, ...headers } }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, type: String(res.headers['content-type']), body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startDashboard', () => {
  let dashboard: Dashboard;
  afterEach(() => dashboard?.close());

  it('serves the page and the figures behind it', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData() });
    expect(dashboard.url).toBe(`http://localhost:${dashboard.port}`);

    const page = await get(dashboard.port, '/');
    expect(page.status).toBe(200);
    expect(page.type).toContain('text/html');
    expect(page.body).toContain('<title>aimux dashboard</title>');

    expect(JSON.parse((await get(dashboard.port, '/api/limits')).body)).toMatchObject({ fetchedAt: 1, order: ['main'] });
    expect(JSON.parse((await get(dashboard.port, '/api/limits?fresh=1')).body).fetchedAt).toBe(2);
    expect(JSON.parse((await get(dashboard.port, '/api/usage?since=24h')).body).since).toBe('24h');
    expect(JSON.parse((await get(dashboard.port, '/api/usage')).body).since).toBe('7d');
    expect(JSON.parse((await get(dashboard.port, '/api/history?hours=48')).body)).toEqual([{ at: 48, profiles: {} }]);
    expect((await get(dashboard.port, '/api/nope')).status).toBe(404);
  });

  it('answers only a browser that asked by its own address', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData() });

    expect((await get(dashboard.port, '/api/limits', 'evil.example')).status).toBe(403);
    expect((await get(dashboard.port, '/api/limits', `evil.example:${dashboard.port}`)).status).toBe(403);
    expect((await get(dashboard.port, '/api/limits', `127.0.0.1:${dashboard.port}`)).status).toBe(200);
  });

  it('gives the figures to its own page only, not to a page elsewhere', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData() });
    const from = (headers: Record<string, string>, path = '/api/limits') => get(dashboard.port, path, undefined, 'GET', headers).then((r) => r.status);

    expect(await from({ 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect(await from({ 'sec-fetch-site': 'same-site' })).toBe(403);
    expect(await from({ origin: 'https://evil.example' })).toBe(403);
    expect(await from({ 'sec-fetch-site': 'same-origin', origin: `http://localhost:${dashboard.port}` })).toBe(200);
    expect(await from({ 'sec-fetch-site': 'none' })).toBe(200);
    // The page itself may be reached by a link from anywhere.
    expect(await from({ 'sec-fetch-site': 'cross-site' }, '/')).toBe(200);
  });

  it('survives an address that is not one', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData() });

    expect((await get(dashboard.port, '//[x')).status).toBe(500);
    expect((await get(dashboard.port, '/api/limits')).status).toBe(200);
  });

  it('is read-only', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData() });

    expect((await get(dashboard.port, '/api/limits', undefined, 'POST')).status).toBe(405);
  });

  it('says why when the figures cannot be read', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData({ usage: async () => { throw new Error('no transcripts'); } }) });

    const reply = await get(dashboard.port, '/api/usage');
    expect(reply.status).toBe(500);
    expect(JSON.parse(reply.body)).toEqual({ error: 'no transcripts' });
  });

  it('refuses a port that was asked for by number and is taken', async () => {
    dashboard = await startDashboard({ port: 0, data: fakeData() });

    await expect(startDashboard({ port: dashboard.port, data: fakeData() })).rejects.toMatchObject({ code: 'EADDRINUSE' });
  });
});

describe('liveData.usage', () => {
  const scanOf = (calls: string[][]) => async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({ since: 'x', profiles: [], days: [], models: [], projects: [], sessions: [] });
  };

  it('scans a short window by the hour and a long one by the day', async () => {
    const calls: string[][] = [];
    const data = liveData(scanOf(calls));

    expect((await data.usage('24h')).hourly).toBe(true);
    expect((await data.usage('7d')).hourly).toBe(false);
    await data.usage('all');

    expect(calls).toEqual([
      ['usage', '--json', '--since', '24h', '--hourly'],
      ['usage', '--json', '--since', '7d'],
      ['usage', '--json', '--all'],
    ]);
  });

  it('answers two readers of the same window from one scan', async () => {
    const calls: string[][] = [];
    const data = liveData(scanOf(calls));

    await Promise.all([data.usage('7d'), data.usage('7d')]);
    await data.usage('7d');

    expect(calls).toHaveLength(1);
  });

  it('shares a scan that is still running, however long it has been', async () => {
    vi.useFakeTimers();
    try {
      let finish: (out: string) => void = () => {};
      let started = 0;
      const data = liveData(() => { started++; return new Promise((resolve) => { finish = resolve; }); });

      const first = data.usage('all');
      vi.advanceTimersByTime(10 * 60_000);
      const second = data.usage('all');
      finish(JSON.stringify({ profiles: [] }));

      await Promise.all([first, second]);
      expect(started).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs two scans at once at most', async () => {
    const data = liveData(() => new Promise(() => {}));
    void data.usage('1h');
    void data.usage('2h');

    await expect(data.usage('3h')).rejects.toThrow('try again in a moment');
  });

  it('scans again after a scan that failed', async () => {
    let failing = true;
    const data = liveData(async () => {
      if (failing) throw new Error('boom');
      return JSON.stringify({ profiles: [] });
    });

    await expect(data.usage('7d')).rejects.toThrow('boom');
    failing = false;
    await expect(data.usage('7d')).resolves.toMatchObject({ profiles: [] });
  });

  it('refuses a window that is not a duration, before running anything', async () => {
    const calls: string[][] = [];

    await expect(liveData(scanOf(calls)).usage('7d; rm -rf ~')).rejects.toThrow("since takes 'all' or a duration");
    expect(calls).toEqual([]);
  });
});

describe('browserCommand', () => {
  it('hands the address to whatever opens a browser on the platform', () => {
    expect(browserCommand('http://localhost:1', 'darwin', {})).toEqual(['open', ['http://localhost:1']]);
    expect(browserCommand('http://localhost:1', 'win32', {})).toEqual(['cmd', ['/c', 'start', '', 'http://localhost:1']]);
    expect(browserCommand('http://localhost:1', 'linux', {})).toEqual(['xdg-open', ['http://localhost:1']]);
    // WSL is linux with no browser of its own: Windows opens it.
    expect(browserCommand('http://localhost:1', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' })).toEqual(['explorer.exe', ['http://localhost:1']]);
  });
});
