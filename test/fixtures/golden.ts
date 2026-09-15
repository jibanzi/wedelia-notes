import { readFileSync } from 'node:fs';

/**
 * Envelopes produced by the Wedelia relay itself, whose server code is not in
 * this repository. The relay accepts a result only if its key set is exact and
 * result_sha256 re-derives, so the plugin has to build byte-for-byte what the
 * relay would -- apart from its own random jti. When the relay's protocol
 * version changes these are regenerated from the relay, never edited by hand.
 */
type Envelope = Record<string, unknown>;

export const golden = JSON.parse(
  readFileSync(new URL('./relay-envelopes.json', import.meta.url), 'utf8'),
) as {
  now_seconds: number;
  search_call: Envelope;
  search_ok_result: Envelope;
  search_null_result: Envelope;
  read_call: Envelope;
  read_not_shared_result: Envelope;
};

/** Every field except the one the plugin must mint fresh. */
export function withoutJti({ jti: _jti, ...rest }: Envelope): Envelope {
  return rest;
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
