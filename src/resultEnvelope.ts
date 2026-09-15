/**
 * Building the answer envelope the relay will actually accept.
 *
 * The relay checks an exact key set and re-derives result_sha256 itself, so a
 * result assembled by spreading the incoming call is rejected outright -- it
 * would carry `args`, which a result may not have. Everything identifying is
 * copied from the call because the relay compares it against the call anyway;
 * the only fields this side gets to decide are ok, result and error_code.
 *
 * Hashing uses the Web Crypto global rather than node:crypto: this runs inside
 * Obsidian, including on mobile.
 */

export interface IncomingCall {
  version: string;
  kind: 'call';
  call_id: string;
  tenant: string;
  user: string;
  tool: string;
  scopes: string[];
  args: Record<string, unknown>;
  args_sha256: string;
  iat: number;
  exp: number;
  jti: string;
}

export type Outcome =
  | { ok: true; result: unknown }
  | { ok: false; errorCode: string };

/**
 * Must match the relay's canonicalisation exactly or every answer comes back
 * BAD_HASH: object keys sorted, no incidental whitespace.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${
    Object.keys(record).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')
  }}`;
}

export async function sha256Json(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function uuid(): string {
  return crypto.randomUUID();
}

export async function buildResultEnvelope(
  call: IncomingCall,
  outcome: Outcome,
): Promise<Record<string, unknown>> {
  const body = outcome.ok
    ? { ok: true, result: outcome.result ?? null }
    : { ok: false, error_code: outcome.errorCode };
  return {
    version: call.version,
    kind: 'result',
    call_id: call.call_id,
    tenant: call.tenant,
    user: call.user,
    tool: call.tool,
    scopes: [...call.scopes],
    args_sha256: call.args_sha256,
    iat: call.iat,
    exp: call.exp,
    jti: uuid(),
    request_jti: call.jti,
    ...body,
    result_sha256: await sha256Json(body),
  };
}
