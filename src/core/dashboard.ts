import { execFile, spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { limitsInsight, type LimitsInsight } from './insights.js';
import { limitsSnapshot } from './limits.js';
import { limitsHistory, type LimitsReading } from './limitsHistory.js';
import { getAimuxDir } from './paths.js';
import { parseSinceDuration, type UsageReport } from './usage.js';

/** A usage report for one window, as the scan printed it. */
export type UsageWindow = UsageReport & { since: string; hourly: boolean; computedAt: number };

/** What the dashboard page and the MCP server both answer from: one source, the same figures. */
export interface AimuxData {
  /** Every subscription's windows judged by pace, and the profiles in the order the config lists them. */
  limits(fresh?: boolean): Promise<LimitsInsight & { order: string[] }>;
  usage(since: string): Promise<UsageWindow>;
  history(hours: number): LimitsReading[];
}

const SINCE = /^(all|\d{1,4}[hdw])$/;
const USAGE_TTL_MS = 60_000;
const HISTORY_POINTS = 300;

// aimux's own entry point, beside this module — not whatever script the process was
// started with, which is another program's when aimux is used as a library. Running from
// source there is no built one, and the process is aimux itself.
const BUILT_CLI = fileURLToPath(new URL('../cli.js', import.meta.url));
const MAX_SCANS = 2;

/**
 * The usage scan reads gigabytes the first time it meets them: run in a process of its
 * own, so whoever is serving keeps answering meanwhile.
 */
function scanInChild(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [...process.execArgv, existsSync(BUILT_CLI) ? BUILT_CLI : process.argv[1], ...args],
      { maxBuffer: 64 << 20, timeout: 600_000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)),
    );
  });
}

export function liveData(scan: (args: string[]) => Promise<string> = scanInChild): AimuxData {
  // `at` is when the scan finished; one still running has none and is always shared.
  const scans = new Map<string, { at?: number; value: Promise<UsageWindow> }>();

  return {
    async limits(fresh = false) {
      const config = loadConfig();
      if (!config) throw new Error('aimux is not set up yet: run `aimux init`');

      // Each reading is a request per subscription: a few minutes old is fresh enough
      // unless the reader asked for it now.
      const insight = limitsInsight(await limitsSnapshot(config, fresh ? 20_000 : 240_000));
      return { ...insight, order: Object.keys(config.profiles) };
    },

    async usage(since) {
      if (!SINCE.test(since)) throw new Error(`since takes 'all' or a duration like 24h, 7d, 4w, not '${since}'`);

      // What has gone stale is forgotten first, so the windows something keeps asking
      // for cannot pile up: the map holds the scans running and the last minute's answers.
      for (const [window, each] of scans) {
        if (each.at !== undefined && Date.now() - each.at >= USAGE_TTL_MS) scans.delete(window);
      }

      const hit = scans.get(since);
      if (hit) return hit.value;

      // Each window asked for is a process reading the transcripts: a few at once at most,
      // however many different windows something keeps asking for.
      const running = [...scans.values()].filter((each) => each.at === undefined).length;
      if (running >= MAX_SCANS) throw new Error('usage is being read for other windows; try again in a moment');

      // Up to two days is drawn by the hour; a day at a time would be two columns.
      const hourly = since !== 'all' && Date.now() - parseSinceDuration(since) <= 48 * 3_600_000;
      const args = ['usage', '--json', ...(since === 'all' ? ['--all'] : ['--since', since]), ...(hourly ? ['--hourly'] : [])];
      const value = scan(args).then((out): UsageWindow => ({ ...JSON.parse(out), hourly, computedAt: Date.now() }));

      // Kept while it runs: a second reader of the window waits for the same scan.
      const entry: { at?: number; value: Promise<UsageWindow> } = { value };
      scans.set(since, entry);
      value.then(
        () => { entry.at = Date.now(); },
        () => { if (scans.get(since) === entry) scans.delete(since); },
      );
      return value;
    },

    history(hours) {
      const readings = limitsHistory(Date.now() - Math.min(Math.max(hours, 1), 24 * 60) * 3_600_000);
      const step = Math.ceil(readings.length / HISTORY_POINTS);

      // Thinned to what a small chart can show, the newest reading always kept.
      return step <= 1 ? readings : readings.filter((_, i) => i % step === 0 || i === readings.length - 1);
    },
  };
}

const DEFAULT_PORT = 4747;
const PAGE_PATH = fileURLToPath(new URL('../../dashboard/index.html', import.meta.url));
// The page is one file with its style and script inside, and talks only to this server.
const PAGE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/**
 * The key to the dashboard, kept in `~/.aimux/dashboard-key` for this user alone, so the
 * address aimux prints stays the same from one run to the next.
 *
 * Listening on 127.0.0.1 keeps other machines out, not other programs on this one: any
 * local user or process, and any web page open in the browser, can send a request here.
 * None of them has the key.
 */
function dashboardKey(): string {
  const path = join(getAimuxDir(), 'dashboard-key');
  try {
    const kept = readFileSync(path, 'utf-8').trim();
    if (/^[\w-]{32}$/.test(kept)) return kept;
  } catch {
    // none yet
  }

  const key = randomBytes(24).toString('base64url');
  try {
    mkdirSync(getAimuxDir(), { recursive: true });
    writeFileSync(path, key, { mode: 0o600 });
  } catch {
    // cannot be kept: a key for this run only
  }

  return key;
}

function isKey(shown: unknown, key: string): boolean {
  if (typeof shown !== 'string') return false;

  const [a, b] = [Buffer.from(shown), Buffer.from(key)];
  return a.length === b.length && timingSafeEqual(a, b);
}

async function answer(req: IncomingMessage, res: ServerResponse, data: AimuxData, port: number, key: string): Promise<void> {
  const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', ...extra });
    res.end(body);
  };
  const json = (status: number, body: unknown) => send(status, 'application/json; charset=utf-8', JSON.stringify(body));

  // Only a browser that asked by the address aimux printed. A page elsewhere on the web
  // can point a host name of its own at 127.0.0.1, but it cannot fake this header.
  const hosts = ['localhost', '127.0.0.1'].flatMap((host) => (port === 80 ? [host, `${host}:80`] : [`${host}:${port}`]));
  if (!hosts.includes(req.headers.host ?? '')) return json(403, { error: 'forbidden host' });
  if (req.method !== 'GET') return json(405, { error: 'the dashboard is read-only' });

  try {
    const url = new URL(req.url ?? '/', 'http://localhost');

    // Nothing is read, scanned or probed for a request without the key. The page gets
    // it in its address; the figures want it in a header, which a page elsewhere cannot
    // attach without the browser asking this server first, and it does not say yes.
    if (url.pathname === '/') {
      if (!isKey(url.searchParams.get('key'), key)) {
        return send(403, 'text/plain; charset=utf-8', 'Open the address that `aimux dashboard` printed: it carries the key to this page.\n');
      }
      return send(200, 'text/html; charset=utf-8', readFileSync(PAGE_PATH), { 'content-security-policy': PAGE_POLICY });
    }
    if (!isKey(req.headers['x-aimux-key'], key)) return json(403, { error: 'forbidden' });

    switch (url.pathname) {
      case '/api/limits':
        return json(200, await data.limits(url.searchParams.has('fresh')));
      case '/api/usage':
        return json(200, await data.usage(url.searchParams.get('since') ?? '7d'));
      case '/api/history':
        return json(200, data.history(Number(url.searchParams.get('hours')) || 168));
      default:
        return json(404, { error: 'not found' });
    }
  } catch (err) {
    return json(500, { error: (err as Error).message });
  }
}

export interface Dashboard {
  url: string;
  port: number;
  close(): Promise<void>;
}

/**
 * Serve the dashboard page and its figures to whoever holds the key, on this machine
 * only. Without a `port` it takes the usual one, or any free one when that is taken (a
 * dashboard already open). `url` carries the key.
 */
export async function startDashboard(options: { port?: number; data?: AimuxData; key?: string } = {}): Promise<Dashboard> {
  const data = options.data ?? liveData();
  const key = options.key ?? dashboardKey();
  let port = 0;
  const server = createServer((req, res) => void answer(req, res, data, port, key).catch(() => res.destroy()));

  const listen = (on: number) =>
    new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(on, '127.0.0.1', () => {
        server.off('error', reject);
        resolve((server.address() as AddressInfo).port);
      });
    });

  try {
    port = await listen(options.port ?? DEFAULT_PORT);
  } catch (err) {
    if (options.port !== undefined || (err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
    port = await listen(0);
  }

  return {
    url: `http://localhost:${port}/?key=${key}`,
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** The command that hands an address to the user's browser on this platform. */
export function browserCommand(url: string, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): [string, string[]] {
  if (platform === 'darwin') return ['open', [url]];
  if (platform === 'win32') return ['cmd', ['/c', 'start', '', url]];
  // WSL has no browser of its own: Windows opens the address.
  if (env.WSL_DISTRO_NAME) return ['explorer.exe', [url]];

  return ['xdg-open', [url]];
}

/** Open the address in the browser, if the machine has a way to. The address is printed either way. */
export function openBrowser(url: string): void {
  const [command, args] = browserCommand(url);

  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // no opener here: the printed address is enough
  }
}
