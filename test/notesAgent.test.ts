import { describe, expect, it, vi } from 'vitest';
import {
  answerCall,
  isShared,
  mintTicket,
  readNote,
  searchVault,
  type VaultReader,
} from '../src/notesAgent.js';

function reader(files: Record<string, string>): VaultReader {
  return {
    markdownFiles: () => Object.keys(files).map((path) => ({ path })),
    read: async (path) => {
      const body = files[path];
      if (body === undefined) throw new Error('ENOENT');
      return body;
    },
  };
}

const NONE = { excludedFolders: [] };

describe('what is shared', () => {
  it('never shares what the mirror wrote into this vault', () => {
    // Without this the line eats its own tail: her exported memories come back
    // to her as if the user had written them down.
    for (const path of [
      'Memories/旅行.md',
      'Diary/2026-08-10.md',
      'People/Alex.md',
      'Itineraries/Osaka.md',
      'Tasks.md',
      'README.md',
    ]) {
      expect(isShared(path, [])).toBe(false);
    }
  });

  it('does not share Obsidian\'s own config', () => {
    expect(isShared('.obsidian/plugins/x/data.json', [])).toBe(false);
  });

  it('honours the user\'s excluded folders, including nested paths', () => {
    expect(isShared('Private/journal.md', ['Private'])).toBe(false);
    expect(isShared('Private/deep/journal.md', ['Private'])).toBe(false);
    expect(isShared('Private/journal.md', ['/Private/'])).toBe(false);
    // A folder that merely starts with the same letters is not excluded.
    expect(isShared('Privateer/notes.md', ['Private'])).toBe(true);
  });

  it('shares an ordinary note', () => {
    expect(isShared('Recipes/kimchi.md', [])).toBe(true);
  });
});

describe('searchVault', () => {
  const vault = reader({
    'Recipes/kimchi.md': 'napa cabbage, gochugaru, salt',
    'Recipes/curry.md': 'onion and gochugaru is wrong here',
    'Trips/osaka.md': 'takoyaki',
    'Memories/旅行.md': 'gochugaru gochugaru gochugaru',
  });

  it('finds notes by body text and skips mirror folders', async () => {
    const hits = await searchVault(vault, NONE, 'gochugaru', 5);
    // Equal scores, so the order is the documented tiebreak: by path, which
    // makes the same vault answer the same way twice.
    expect(hits.map((hit) => hit.path)).toEqual([
      'Recipes/curry.md', 'Recipes/kimchi.md',
    ]);
    // The mirror note scored highest on raw count and still must not appear.
    expect(hits.some((hit) => hit.path.startsWith('Memories/'))).toBe(false);
  });

  it('weighs a title match above a body mention', async () => {
    const hits = await searchVault(vault, NONE, 'kimchi', 5);
    expect(hits[0]!.path).toBe('Recipes/kimchi.md');
  });

  it('returns excerpts, never whole notes', async () => {
    const long = reader({ 'a.md': `${'x'.repeat(5_000)}needle${'y'.repeat(5_000)}` });
    const [hit] = await searchVault(long, NONE, 'needle', 5);
    expect(hit!.excerpt.length).toBeLessThan(500);
    expect(hit!.excerpt).toContain('needle');
  });

  it('respects the caller\'s limit and its own ceiling', async () => {
    const many = reader(Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`n${i}.md`, 'needle']),
    ));
    expect(await searchVault(many, NONE, 'needle', 2)).toHaveLength(2);
    expect(await searchVault(many, NONE, 'needle', 99)).toHaveLength(5);
  });

  it('answers an empty query with nothing rather than everything', async () => {
    expect(await searchVault(vault, NONE, '   ', 5)).toEqual([]);
  });

  it('skips a file it cannot read instead of failing the whole search', async () => {
    const flaky: VaultReader = {
      markdownFiles: () => [{ path: 'good.md' }, { path: 'gone.md' }],
      read: async (path) => {
        if (path === 'gone.md') throw new Error('ENOENT');
        return 'needle';
      },
    };
    expect((await searchVault(flaky, NONE, 'needle', 5)).map((h) => h.path))
      .toEqual(['good.md']);
  });
});

describe('searchVault on a vault too big to read', () => {
  // Measured on a real vault: 49,802 notes, 60.8 MB, 17.1s just to read them all,
  // against an 18s envelope. Reading everything was never going to work.
  function hugeVault(count: number, reads: { n: number }) {
    const files = Array.from({ length: count }, (_, i) => ({
      path: `notes/${i}.md`,
      mtimeMs: i,
      keywords: [] as string[],
    }));
    files.push({ path: 'Recipes/kimchi.md', mtimeMs: 0, keywords: ['gochugaru'] });
    return {
      markdownFiles: () => files,
      read: async (path: string) => {
        reads.n += 1;
        return path.includes('kimchi') ? 'napa cabbage' : 'nothing to see';
      },
    };
  }

  it('finds a note by its name without reading the whole vault', async () => {
    const reads = { n: 0 };
    const hits = await searchVault(hugeVault(50_000, reads), NONE, 'kimchi', 5);
    expect(hits.map((h) => h.path)).toEqual(['Recipes/kimchi.md']);
    // One name matched, so exactly one body was worth opening.
    expect(reads.n).toBe(1);
  });

  it('finds a note by a heading Obsidian already had in memory', async () => {
    const reads = { n: 0 };
    const hits = await searchVault(hugeVault(50_000, reads), NONE, 'gochugaru', 5);
    expect(hits.map((h) => h.path)).toEqual(['Recipes/kimchi.md']);
    expect(reads.n).toBe(1);
  });

  it('stops at its budget instead of running past the envelope', async () => {
    const reads = { n: 0 };
    // Every read costs 100ms of pretend time; the budget allows five.
    let clock = 0;
    const slow = {
      markdownFiles: () => Array.from({ length: 10_000 }, (_, i) => ({
        path: `n${i}.md`, mtimeMs: i, keywords: [],
      })),
      read: async () => { reads.n += 1; clock += 100; return 'no match here'; },
    };
    const hits = await searchVault(slow, NONE, 'needle', 5, {
      budgetMs: 500, now: () => clock,
    });
    expect(hits).toEqual([]);
    // Answering late is the one failure mode this cannot have.
    expect(reads.n).toBeLessThanOrEqual(6);
  });

  it('still reads bodies when nothing matches for free', async () => {
    const reads = { n: 0 };
    const vault = {
      markdownFiles: () => [
        { path: 'a.md', mtimeMs: 1, keywords: [] },
        { path: 'b.md', mtimeMs: 2, keywords: [] },
      ],
      read: async (path: string) => {
        reads.n += 1;
        return path === 'b.md' ? 'the needle is here' : 'nothing';
      },
    };
    const hits = await searchVault(vault, NONE, 'needle', 5);
    expect(hits.map((h) => h.path)).toEqual(['b.md']);
    expect(reads.n).toBe(2);
  });
});

describe('readNote', () => {
  const vault = reader({ 'Recipes/kimchi.md': '# kimchi', 'Memories/x.md': 'hers' });

  it('reads a shared note', async () => {
    await expect(readNote(vault, NONE, 'Recipes/kimchi.md'))
      .resolves.toEqual({ ok: true, body: '# kimchi' });
  });

  it('gives the same answer for unshared and nonexistent', async () => {
    // Otherwise the two answers together map the vault one path at a time.
    await expect(readNote(vault, NONE, 'Memories/x.md'))
      .resolves.toEqual({ ok: false, errorCode: 'NOT_SHARED' });
    await expect(readNote(vault, NONE, 'Nope/missing.md'))
      .resolves.toEqual({ ok: false, errorCode: 'NOT_SHARED' });
    await expect(readNote(vault, NONE, '../../etc/passwd'))
      .resolves.toEqual({ ok: false, errorCode: 'NOT_SHARED' });
  });

  it('caps a very long note', async () => {
    const huge = reader({ 'big.md': 'z'.repeat(100_000) });
    const read = await readNote(huge, NONE, 'big.md');
    expect(read.ok && read.body.length).toBe(40_000);
  });
});

describe('answerCall', () => {
  const vault = reader({ 'a.md': 'needle' });

  it('answers a search', async () => {
    await expect(answerCall(vault, NONE, {
      tool: 'search_my_notes', args: { query: 'needle' },
    })).resolves.toMatchObject({ ok: true });
  });

  it('refuses a tool it does not implement', async () => {
    await expect(answerCall(vault, NONE, {
      tool: 'query_db', args: {},
    })).resolves.toEqual({ ok: false, errorCode: 'TOOL_FAILED' });
  });

  it('does not crash on arguments of the wrong type', async () => {
    await expect(answerCall(vault, NONE, {
      tool: 'search_my_notes', args: { query: 42 },
    })).resolves.toMatchObject({ ok: true, result: { hits: [] } });
  });
});

describe('mintTicket', () => {
  const config = {
    apiOrigin: 'https://api.example', username: 'wednesday', password: 'tok',
  };

  it('sends the vault credential and returns the ticket', async () => {
    const fetchImpl = vi.fn(async (
      _input: RequestInfo | URL,
      _init?: RequestInit,
    ) => new Response(
      JSON.stringify({ ticket: 'wnt1.a.1.2.3', expires_at: 1, relay_origin: 'https://r' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const ticket = await mintTicket(config, fetchImpl as unknown as typeof fetch);
    expect(ticket?.relay_origin).toBe('https://r');
    const init = fetchImpl.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>).authorization)
      .toBe(`Basic ${btoa('wednesday:tok')}`);
  });

  it('returns nothing rather than throwing, whatever went wrong', async () => {
    for (const impl of [
      async () => new Response('{}', { status: 401 }),
      async () => new Response('not json', { status: 200 }),
      async () => { throw new Error('offline'); },
    ]) {
      await expect(mintTicket(config, impl as unknown as typeof fetch))
        .resolves.toBeUndefined();
    }
  });
});
