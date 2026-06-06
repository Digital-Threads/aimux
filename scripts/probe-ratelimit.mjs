#!/usr/bin/env node
// Dev spike (aimux-xv6): discover the live rate-limit response headers an
// Anthropic subscription OAuth token returns, so limits.ts can parse the real
// 5h / weekly window percentages. The unified subscription headers are not in
// the public docs — only a live probe reveals their exact names/shape.
//
// Usage:
//   node scripts/probe-ratelimit.mjs [profilePath]
// profilePath defaults to ~/.claude (the source profile). For an isolated
// profile pass e.g. ~/.aimux/profiles/dt
//
// Cost: ONE message request with max_tokens:1 (haiku). Prints ONLY headers
// whose name starts with "anthropic-ratelimit" plus the HTTP status. The
// access token is read but never printed.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const profilePath = process.argv[2]
  ? process.argv[2].replace(/^~(?=$|\/)/, homedir())
  : join(homedir(), '.claude');

function loadToken(dir) {
  const raw = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf-8'));
  // Known Claude Code shape: { claudeAiOauth: { accessToken, expiresAt, ... } }
  const oauth = raw.claudeAiOauth ?? raw.claude_ai_oauth ?? raw;
  const token = oauth.accessToken ?? oauth.access_token;
  if (!token) throw new Error('No accessToken in .credentials.json (is this an OAuth profile?)');
  return token;
}

async function main() {
  const token = loadToken(profilePath);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1,
      // Subscription OAuth requires this exact first system line or it 403s.
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  console.log(`HTTP ${res.status} ${res.statusText}`);
  console.log('--- anthropic-ratelimit* headers ---');
  let found = 0;
  for (const [k, v] of res.headers.entries()) {
    if (k.toLowerCase().startsWith('anthropic-ratelimit')) {
      console.log(`${k}: ${v}`);
      found++;
    }
  }
  if (found === 0) {
    console.log('(none — dumping ALL anthropic-* headers instead)');
    for (const [k, v] of res.headers.entries()) {
      if (k.toLowerCase().startsWith('anthropic-')) console.log(`${k}: ${v}`);
    }
  }
  if (res.status >= 400) {
    const body = await res.text();
    console.log('--- error body (first 500 chars) ---');
    console.log(body.slice(0, 500));
  }
}

main().catch((err) => {
  console.error(`probe failed: ${err.message}`);
  process.exit(1);
});
