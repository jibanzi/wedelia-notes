/**
 * The half of the Obsidian plugin that has nothing to do with Obsidian.
 *
 * Everything here is driven through two injected seams -- a VaultReader and a
 * fetch -- so the whole loop, the sharing rules and the search can be tested
 * without an Obsidian runtime. `main.ts` is the thin adapter that supplies the
 * real ones.
 */

export interface VaultFile {
  /** Vault-relative, no leading slash, as Obsidian reports it. */
  path: string;
  /** Free from Obsidian; used to pick candidates when nothing matches by name. */
  mtimeMs?: number;
  /**
   * Headings, tags and aliases, which Obsidian keeps in memory. Free to read
   * and often enough to find the right note without touching the disk at all.
   */
  keywords?: string[];
}

export interface VaultReader {
  markdownFiles(): VaultFile[];
  read(path: string): Promise<string>;
}

export interface NotesAgentConfig {
  /** Where the ticket is minted: the same origin the App shows. */
  apiOrigin: string;
  /** The vault credential the user already pasted in for the mirror. */
  username: string;
  password: string;
  /** Folders the user has chosen not to share, vault-relative. */
  excludedFolders: string[];
}

/**
 * Paths the mirror writes into this same vault. Without this the line eats its
 * own tail: her exported memories land here as files, and a search would hand
 * them back to her as if the user had written them down -- each pass making
 * the next one more confident. Not an optimisation; correctness.
 */
const MIRROR_PATHS = ['Memories', 'Diary', 'People', 'Itineraries'];
const MIRROR_FILES = ['Tasks.md', 'README.md'];

const MAX_HITS = 5;
const MAX_EXCERPT_CHARS = 400;
/**
 * How long a search may spend reading files.
 *
 * The envelope this answers lives 18s, so the budget is the part of that a
 * search may keep, leaving the rest for the round trip. It is a budget rather
 * than a file-count cap because what matters is answering in time, and 40,000
 * small notes and 400 large ones are the same problem in different clothes.
 * Over budget, the answer is what was found so far -- degrading to "less"
 * rather than to "nothing".
 */
const SEARCH_BUDGET_MS = 8_000;
/** Bodies to read when nothing matches for free, newest first. */
const BLIND_SCAN_LIMIT = 400;
/** Well under the relay's 128KB result cap, with room for paths and JSON. */
const MAX_NOTE_CHARS = 40_000;

export function isShared(path: string, excludedFolders: string[]): boolean {
  const normalised = path.replace(/^\/+/, '');
  if (normalised.startsWith('.')) return false;
  if (MIRROR_FILES.includes(normalised)) return false;
  const top = normalised.split('/')[0] ?? '';
  if (MIRROR_PATHS.includes(top)) return false;
  return !excludedFolders.some((folder) => {
    const clean = folder.replace(/^\/+|\/+$/g, '');
    return clean.length > 0
      && (normalised === clean || normalised.startsWith(`${clean}/`));
  });
}

function excerptAround(body: string, at: number): string {
  const start = Math.max(0, at - MAX_EXCERPT_CHARS / 4);
  return `${start > 0 ? '…' : ''}${
    body.slice(start, start + MAX_EXCERPT_CHARS).trim()
  }${start + MAX_EXCERPT_CHARS < body.length ? '…' : ''}`;
}

export interface NoteHit {
  path: string;
  excerpt: string;
}

/**
 * Substring scoring, no index and no embeddings. Everything runs on the user's
 * own machine on a vault they curated themselves, so the cheapest thing that
 * finds the right note is the right amount of machinery. If real use shows it
 * missing things, Obsidian's own search index is sitting right there.
 */
export async function searchVault(
  reader: VaultReader,
  config: Pick<NotesAgentConfig, 'excludedFolders'>,
  query: string,
  limit: number,
  options: { budgetMs?: number; now?: () => number } = {},
): Promise<NoteHit[]> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const now = options.now ?? (() => Date.now());
  const deadline = now() + (options.budgetMs ?? SEARCH_BUDGET_MS);

  const shared = reader.markdownFiles()
    .filter((file) => isShared(file.path, config.excludedFolders));

  // Everything in this pass is already in memory: Obsidian hands over paths,
  // mtimes and the metadata cache without touching the disk. On a 50k-note
  // vault this is the difference between answering and timing out.
  const scoredFree = shared.map((file) => {
    const name = file.path.toLowerCase();
    const keywords = (file.keywords ?? []).join(' ').toLowerCase();
    let score = 0;
    for (const term of terms) {
      if (name.includes(term)) score += 3;
      if (keywords.includes(term)) score += 2;
    }
    return { file, score };
  });

  const candidates = scoredFree.filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  // Only when nothing matched by name or heading at all. A single name match
  // is worth one read; going on to open 400 more notes on the chance of a
  // better one is how a search on a 50k-note vault stops answering in time.
  // The ceiling that buys: a term living only in the body of an old note,
  // whose name and headings never mention it, is not found. A real index is
  // the upgrade, not a bigger scan.
  if (candidates.length === 0) {
    const rest = scoredFree.filter((entry) => entry.score === 0)
      .sort((a, b) => (b.file.mtimeMs ?? 0) - (a.file.mtimeMs ?? 0))
      .slice(0, BLIND_SCAN_LIMIT);
    candidates.push(...rest);
  }

  const hits: { hit: NoteHit; score: number }[] = [];
  for (const { file, score } of candidates) {
    if (now() >= deadline) break;
    let body: string;
    try {
      body = await reader.read(file.path);
    } catch {
      continue;
    }
    const haystack = body.toLowerCase();
    let bodyScore = 0;
    let firstAt = -1;
    for (const term of terms) {
      const at = haystack.indexOf(term);
      if (at >= 0) {
        bodyScore += 1;
        if (firstAt < 0 || at < firstAt) firstAt = at;
      }
    }
    if (score === 0 && bodyScore === 0) continue;
    hits.push({
      score: score + bodyScore,
      hit: { path: file.path, excerpt: excerptAround(body, Math.max(0, firstAt)) },
    });
  }

  return hits
    .sort((a, b) => b.score - a.score || a.hit.path.localeCompare(b.hit.path))
    .slice(0, Math.min(limit, MAX_HITS))
    .map((entry) => entry.hit);
}

export async function readNote(
  reader: VaultReader,
  config: Pick<NotesAgentConfig, 'excludedFolders'>,
  path: string,
): Promise<{ ok: true; body: string } | { ok: false; errorCode: 'NOT_SHARED' }> {
  if (!isShared(path, config.excludedFolders)) return { ok: false, errorCode: 'NOT_SHARED' };
  const known = reader.markdownFiles().some((file) => file.path === path);
  // Same answer for "outside what you shared" and "does not exist", so a
  // caller cannot map the vault by asking for paths.
  if (!known) return { ok: false, errorCode: 'NOT_SHARED' };
  try {
    return { ok: true, body: (await reader.read(path)).slice(0, MAX_NOTE_CHARS) };
  } catch {
    return { ok: false, errorCode: 'NOT_SHARED' };
  }
}

/** Only what answering needs. The rest of the envelope is the relay's business. */
interface CallEnvelope {
  tool: string;
  args: Record<string, unknown>;
}

/** Answers one call. Exported so the loop stays trivial and this stays tested. */
export async function answerCall(
  reader: VaultReader,
  config: Pick<NotesAgentConfig, 'excludedFolders'>,
  call: CallEnvelope,
): Promise<{ ok: true; result: unknown } | { ok: false; errorCode: string }> {
  if (call.tool === 'search_my_notes') {
    const query = typeof call.args.query === 'string' ? call.args.query : '';
    const limit = typeof call.args.limit === 'number' ? call.args.limit : MAX_HITS;
    return { ok: true, result: { hits: await searchVault(reader, config, query, limit) } };
  }
  if (call.tool === 'read_my_note') {
    const path = typeof call.args.path === 'string' ? call.args.path : '';
    const read = await readNote(reader, config, path);
    return read.ok
      ? { ok: true, result: { path, body: read.body } }
      : { ok: false, errorCode: read.errorCode };
  }
  return { ok: false, errorCode: 'TOOL_FAILED' };
}

export interface Ticket {
  ticket: string;
  expires_at: number;
  relay_origin: string;
}

/**
 * Mint, or fail. The plugin treats every failure the same way -- wait and try
 * again -- because the difference between "wrong password" and "server down"
 * is not something it can act on differently, and a plugin that gives up
 * permanently on a transient error is worse than one that keeps knocking.
 */
export async function mintTicket(
  config: Pick<NotesAgentConfig, 'apiOrigin' | 'username' | 'password'>,
  fetchImpl: typeof fetch,
): Promise<Ticket | undefined> {
  const authorization = `Basic ${
    btoa(`${config.username}:${config.password}`)
  }`;
  try {
    const response = await fetchImpl(`${config.apiOrigin}/v1/vault/notes/ticket`, {
      method: 'POST',
      headers: { authorization },
    });
    if (!response.ok) return undefined;
    const body = await response.json() as Ticket;
    return typeof body.ticket === 'string' && typeof body.relay_origin === 'string'
      ? body
      : undefined;
  } catch {
    return undefined;
  }
}
