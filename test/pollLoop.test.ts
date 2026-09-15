import { describe, expect, it } from 'vitest';
import { runPollLoop } from '../src/pollLoop.js';
import type { VaultReader } from '../src/notesAgent.js';
import { golden, withoutJti } from './fixtures/golden.js';

const NOW = golden.now_seconds;

const reader: VaultReader = {
  markdownFiles: () => [{ path: 'Recipes/kimchi.md' }],
  read: async () => 'napa cabbage, gochugaru',
};

const config = {
  apiOrigin: 'https://api.example',
  username: 'wednesday',
  password: 'tok',
  excludedFolders: [],
};

const TICKET = {
  ticket: 'wnt1.x.1.2.3', expires_at: NOW + 3_600, relay_origin: 'https://relay.example',
};

interface Scripted {
  fetchImpl: typeof fetch;
  calls: { url: string; body?: unknown }[];
}

/** A fetch that plays a fixed script and then holds the loop still. */
function scripted(
  plan: (url: string, seen: number) => Response | 'stop',
  stop: AbortController,
): Scripted {
  const calls: { url: string; body?: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) as unknown : undefined,
    });
    const next = plan(url, calls.length);
    if (next === 'stop') {
      stop.abort();
      throw new Error('aborted');
    }
    return next;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const json = (value: unknown, status = 200) => new Response(
  JSON.stringify(value),
  { status, headers: { 'content-type': 'application/json' } },
);

describe('runPollLoop', () => {
  it('mints, polls, and answers with the result the relay expects', async () => {
    const stop = new AbortController();
    const call = golden.search_call;
    const { fetchImpl, calls } = scripted((url, seen) => {
      if (url.endsWith('/v1/vault/notes/ticket')) return json(TICKET);
      if (url.endsWith('/v1/notes/poll')) return seen <= 2 ? json({ call }) : 'stop';
      if (url.endsWith('/v1/notes/result')) return json({}, 202);
      return json({}, 404);
    }, stop);

    await runPollLoop({
      reader,
      config,
      fetchImpl,
      sleep: async () => undefined,
      nowSeconds: () => NOW,
      signal: stop.signal,
    });

    const posted = calls.find((entry) => entry.url.endsWith('/v1/notes/result'));
    expect(posted).toBeDefined();
    // Byte-for-byte what the relay itself builds for this call and this hit.
    expect(withoutJti(posted!.body as Record<string, unknown>))
      .toStrictEqual(withoutJti(golden.search_ok_result));
  });

  it('re-mints when a ticket is refused mid-flight', async () => {
    const stop = new AbortController();
    let mints = 0;
    const { fetchImpl } = scripted((url, seen) => {
      if (url.endsWith('/v1/vault/notes/ticket')) {
        mints += 1;
        return json(TICKET);
      }
      if (url.endsWith('/v1/notes/poll')) {
        if (seen <= 2) return json({}, 401);
        return 'stop';
      }
      return json({}, 404);
    }, stop);

    await runPollLoop({
      reader,
      config,
      fetchImpl,
      sleep: async () => undefined,
      nowSeconds: () => NOW,
      signal: stop.signal,
    });
    expect(mints).toBeGreaterThanOrEqual(2);
  });

  it('re-mints before expiry rather than after a refusal', async () => {
    const stop = new AbortController();
    let mints = 0;
    const { fetchImpl } = scripted((url, seen) => {
      if (url.endsWith('/v1/vault/notes/ticket')) {
        mints += 1;
        // Always nearly expired, so every pass has to re-mint.
        return json({ ...TICKET, expires_at: NOW + 60 });
      }
      if (url.endsWith('/v1/notes/poll')) return seen <= 4 ? json({}, 204) : 'stop';
      return json({}, 404);
    }, stop);

    await runPollLoop({
      reader,
      config,
      fetchImpl,
      sleep: async () => undefined,
      nowSeconds: () => NOW,
      signal: stop.signal,
    });
    expect(mints).toBeGreaterThan(1);
  });

  it('sleeps on every failure path instead of spinning', async () => {
    const stop = new AbortController();
    let slept = 0;
    const { fetchImpl } = scripted((url, seen) => {
      if (url.endsWith('/v1/vault/notes/ticket')) {
        return seen <= 3 ? json({}, 500) : 'stop';
      }
      return json({}, 404);
    }, stop);

    await runPollLoop({
      reader,
      config,
      fetchImpl,
      sleep: async () => { slept += 1; },
      nowSeconds: () => NOW,
      signal: stop.signal,
    });
    // A plugin that retried a dead server with no delay would be a busy loop
    // on the user's laptop.
    expect(slept).toBeGreaterThanOrEqual(3);
  });

  it('stops when the plugin is unloaded', async () => {
    const stop = new AbortController();
    stop.abort();
    const { calls, fetchImpl } = scripted(() => json({}, 200), stop);
    await runPollLoop({
      reader,
      config,
      fetchImpl,
      sleep: async () => undefined,
      nowSeconds: () => NOW,
      signal: stop.signal,
    });
    expect(calls).toHaveLength(0);
  });
});
