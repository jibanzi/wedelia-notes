import { buildResultEnvelope, type IncomingCall } from './resultEnvelope.js';
import {
  answerCall,
  mintTicket,
  type NotesAgentConfig,
  type Ticket,
  type VaultReader,
} from './notesAgent.js';

/**
 * Hold a request open, answer whatever comes down it, hold another.
 *
 * The loop never gives up permanently. A wrong password and a server that is
 * down are indistinguishable from here and the plugin could not act on the
 * difference anyway, so both mean "wait and knock again". What it must not do
 * is spin: every failure path sleeps first.
 */

export interface PollLoopDeps {
  reader: VaultReader;
  config: NotesAgentConfig;
  fetchImpl: typeof fetch;
  /** Injected so tests do not actually wait. */
  sleep: (ms: number) => Promise<void>;
  nowSeconds: () => number;
  signal: AbortSignal;
  /**
   * Told what went wrong and where. Without this the plugin fails in total
   * silence: the user sees a toggle that looks on, and anyone debugging sees
   * nothing at all -- which is exactly how an afternoon got spent guessing
   * whether a request was blocked before it ever left the machine.
   */
  onError?: (stage: string, detail: string) => void;
  onConnected?: () => void;
}

export const RETRY_MS = 15_000;
/** Re-mint this long before expiry rather than after a rejected poll. */
const TICKET_REFRESH_MARGIN_SECONDS = 300;

export async function runPollLoop(deps: PollLoopDeps): Promise<void> {
  let ticket: Ticket | undefined;

  while (!deps.signal.aborted) {
    if (
      !ticket
      || ticket.expires_at - TICKET_REFRESH_MARGIN_SECONDS <= deps.nowSeconds()
    ) {
      ticket = await mintTicket(deps.config, deps.fetchImpl);
      if (!ticket) {
        deps.onError?.('mint', 'could not get a ticket: check the vault password');
        await deps.sleep(RETRY_MS);
        continue;
      }
    }

    let polled: Response;
    try {
      polled = await deps.fetchImpl(`${ticket.relay_origin}/v1/notes/poll`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ticket.ticket}` },
        signal: deps.signal,
      });
    } catch (error) {
      if (deps.signal.aborted) return;
      // A fetch that throws here never reached the network -- blocked before
      // it left, or the host is unreachable. The message is the only thing
      // that tells those apart.
      deps.onError?.('poll', error instanceof Error ? error.message : String(error));
      await deps.sleep(RETRY_MS);
      continue;
    }

    if (polled.status === 401) {
      // The ticket died early -- revoked credential, or a redeployed relay.
      ticket = undefined;
      await deps.sleep(RETRY_MS);
      continue;
    }
    // 204 is the ordinary "nothing yet"; poll again immediately.
    if (polled.status !== 200) {
      if (polled.status !== 204) {
        deps.onError?.('poll', `relay answered ${polled.status}`);
        await deps.sleep(RETRY_MS);
      } else {
        deps.onConnected?.();
      }
      continue;
    }

    let call: IncomingCall;
    try {
      ({ call } = await polled.json() as { call: IncomingCall });
    } catch (error) {
      deps.onError?.('poll', `unreadable call: ${String(error)}`);
      await deps.sleep(RETRY_MS);
      continue;
    }

    deps.onConnected?.();
    const outcome = await answerCall(deps.reader, deps.config, call);
    // Only ok/result/error_code are decided here. The relay compares every
    // other field against the call it sent and re-derives the hash, so a
    // hand-assembled envelope is thrown away rather than believed.
    const body = await buildResultEnvelope(call, outcome);
    try {
      await deps.fetchImpl(`${ticket.relay_origin}/v1/notes/result`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${ticket.ticket}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: deps.signal,
      });
    } catch (error) {
      // The call expires on its own in seconds; nothing to reconcile.
      if (deps.signal.aborted) return;
      deps.onError?.('result', error instanceof Error ? error.message : String(error));
    }
  }
}
