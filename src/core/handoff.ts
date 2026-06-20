import { readFileSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { AimuxConfig } from '../types/index.js';
import { expandHome } from './paths.js';
import { sourceFor, getProfile } from './config.js';
import { adapterFor } from './adapters/index.js';
import { runProfileHeadless } from './run.js';
import { launchProfile } from './run.js';
import { unifyAllSessions, type UnifiedSession } from './unifiedSessions.js';

/** Hard cap on transcript text fed to the summarizer, so a long session can't blow up
 *  the summarizer's own context. Keeps the tail (most recent state matters most). */
const TRANSCRIPT_CHAR_BUDGET = 60_000;

/** Seed prompt handed to the TARGET CLI to continue a conversation from another CLI. */
export function buildHandoffPrompt(summary: string): string {
  return [
    'You are continuing a conversation that took place in another AI assistant.',
    'The previous session reached its usage limit and was handed off to you.',
    'Here is a summary of what happened and where things stand:',
    '',
    summary.trim(),
    '',
    'Continue from here. Pick up the work as if it had been your own session.',
  ].join('\n');
}

/** Prompt asking a CLI to compress a transcript into a continuation-ready summary. */
export function buildSummarizePrompt(transcript: string): string {
  return [
    'Summarize the following AI coding session so it can be continued in a different assistant.',
    'Capture: the goal, key decisions, the current state, files/commands involved, and the immediate next step.',
    'Be concise but complete. Output only the summary, no preamble.',
    '',
    '--- TRANSCRIPT ---',
    transcript,
  ].join('\n');
}

function tail(text: string, budget: number): string {
  return text.length <= budget ? text : text.slice(text.length - budget);
}

/** Best-effort raw transcript text for a session, per source CLI. Returns '' if the
 *  transcript can't be located (caller falls back to the session intent). */
export function readTranscript(config: AimuxConfig, session: UnifiedSession): string {
  try {
    if (session.cli === 'codex') {
      const root = join(expandHome(sourceFor(config, 'codex')), 'sessions');
      if (!existsSync(root)) return '';
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const name of readdirSync(dir)) {
          const p = join(dir, name);
          const st = statSync(p);
          if (st.isDirectory()) stack.push(p);
          else if (name.includes(session.sessionId) && name.endsWith('.jsonl')) {
            return tail(readFileSync(p, 'utf-8'), TRANSCRIPT_CHAR_BUDGET);
          }
        }
      }
      return '';
    }
    // claude: projects/<cwdHashDir>/<sessionId>.jsonl
    if (!session.cwdHashDir) return '';
    const path = join(
      expandHome(sourceFor(config, 'claude')),
      'projects',
      session.cwdHashDir,
      `${session.sessionId}.jsonl`,
    );
    if (!existsSync(path)) return '';
    return tail(readFileSync(path, 'utf-8'), TRANSCRIPT_CHAR_BUDGET);
  } catch {
    return '';
  }
}

export interface HandoffDeps {
  findSession(config: AimuxConfig, sessionId: string): UnifiedSession | undefined;
  readTranscript(config: AimuxConfig, session: UnifiedSession): string;
  summarize(config: AimuxConfig, viaProfile: string, prompt: string): Promise<string>;
  launch(config: AimuxConfig, toProfile: string, seedPrompt: string): Promise<number>;
}

const defaultDeps: HandoffDeps = {
  findSession(config, sessionId) {
    const all = unifyAllSessions(config, { windowDays: Infinity });
    return all.find((s) => s.sessionId === sessionId || s.short === sessionId);
  },
  readTranscript,
  async summarize(config, viaProfile, prompt) {
    const adapter = adapterFor(getProfile(config, viaProfile).cli);
    if (adapter.headlessCaptureToFile) {
      // codex: read the clean final message from a temp file (stdout is noisy).
      const outFile = join(tmpdir(), `aimux-handoff-${process.pid}-${randomBytes(4).toString('hex')}.txt`);
      try {
        await runProfileHeadless(config, viaProfile, { extraArgs: adapter.headlessArgs(prompt, outFile) });
        return existsSync(outFile) ? readFileSync(outFile, 'utf-8').trim() : '';
      } finally {
        try {
          unlinkSync(outFile);
        } catch {
          /* best-effort cleanup */
        }
      }
    }
    const res = await runProfileHeadless(config, viaProfile, { extraArgs: adapter.headlessArgs(prompt) });
    return res.stdout.trim();
  },
  launch(config, toProfile, seedPrompt) {
    return launchProfile(config, toProfile, { extraArgs: [seedPrompt] });
  },
};

export interface HandoffResult {
  sessionId: string;
  fromCli: string;
  toProfile: string;
  summary: string;
  exitCode: number;
}

/** Continue a session from one CLI under a profile of (possibly) another CLI, via a
 *  summary handoff: read the source transcript, summarize it with the target profile,
 *  then launch the target seeded with that summary. Self-contained — no external
 *  orchestration. The summary is produced by the target CLI itself. */
export async function handoffSession(
  config: AimuxConfig,
  sessionId: string,
  toProfile: string,
  deps: HandoffDeps = defaultDeps,
): Promise<HandoffResult> {
  const session = deps.findSession(config, sessionId);
  if (!session) {
    throw new Error(`Session '${sessionId}' not found`);
  }
  const transcript = deps.readTranscript(config, session) || session.intent || '';
  if (!transcript) {
    throw new Error(`No transcript content found for session '${sessionId}'`);
  }
  const summary = await deps.summarize(config, toProfile, buildSummarizePrompt(transcript));
  if (!summary) {
    throw new Error('Summarizer produced no output');
  }
  const exitCode = await deps.launch(config, toProfile, buildHandoffPrompt(summary));
  return { sessionId: session.sessionId, fromCli: session.cli, toProfile, summary, exitCode };
}
