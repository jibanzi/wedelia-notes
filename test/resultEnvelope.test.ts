import { describe, expect, it } from 'vitest';
import { canonicalJson, buildResultEnvelope, type IncomingCall } from '../src/resultEnvelope.js';
import { golden, UUID_V4, withoutJti } from './fixtures/golden.js';

describe('canonicalJson', () => {
  it('sorts keys so both sides hash the same bytes', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ a: [3, { d: 1, c: 2 }] })).toBe('{"a":[3,{"c":2,"d":1}]}');
    expect(canonicalJson(null)).toBe('null');
  });
});

describe('the plugin builds exactly what the relay builds', () => {
  const cases = [
    ['a successful search', golden.search_call, { ok: true, result: golden.search_ok_result.result }, golden.search_ok_result],
    ['a null result', golden.search_call, { ok: true, result: null }, golden.search_null_result],
    ['a refusal', golden.read_call, { ok: false, errorCode: 'NOT_SHARED' }, golden.read_not_shared_result],
  ] as const;

  for (const [name, call, outcome, expected] of cases) {
    it(`for ${name}`, async () => {
      const built = await buildResultEnvelope(call as unknown as IncomingCall, outcome);
      // Same keys, same values, same result_sha256. Spreading the incoming
      // call would drag `args` along, which a result may not carry.
      expect(withoutJti(built)).toStrictEqual(withoutJti(expected));
      expect(built.jti).toMatch(UUID_V4);
      expect(built.jti).not.toBe(call.jti);
    });
  }
});
