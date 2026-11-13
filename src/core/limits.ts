import { isJSONRPCRequest } from '@modelcontextprotocol/server';
import { Effect, Option, Predicate, Schema } from 'effect';
import { SITE_URL, TIERS, type Caller, type Env } from '../env';
import { chargeOf } from './tools';

export const CONTACT_URL = `${SITE_URL}/contact`;
export const CONSULTANT_URL = `${SITE_URL}/consultant`;

/** Which limits a caller gets. A connector address is an anonymous tier caller with a larger, shared allowance. */
export type LimitProfile = 'anonymous' | 'connector' | 'registered';
export interface Quota {
  /** The per-minute ratelimit binding. */
  binding: 'RL_ANON' | 'RL_KEY';
  /** Per UTC day. */
  toolCalls: number; providerProfiles: number; contentReads: number;
  /** Not-found lookups allowed in an hour before tool calls are blocked for an hour; null for no block. */
  notFoundPerHour: number | null;
}
/** Every number the abuse limits use. Plan: comparethecloud-mcp-oauth-plan-v1.md section 2, with Daniel's
 *  13 November 2026 change to provider profiles (30 anonymous, 150 signed in). */
export const QUOTAS = {
  anonymous: { binding: TIERS.anonymous.binding, toolCalls: 2_000, providerProfiles: 30, contentReads: 300, notFoundPerHour: 30 },
  registered: { binding: TIERS.registered.binding, toolCalls: 10_000, providerProfiles: 150, contentReads: 2_000, notFoundPerHour: 30 },
  // One connector address carries many people, so it gets 600 a minute and 20,000 calls a day (plan section 2).
  // The plan sets no profile or content numbers for it: these are the anonymous ones scaled 10x like the call
  // limits, pending Daniel's decision. It has no not-found block at all: one user guessing slugs would lock out
  // everyone behind the address. A per-client limit inside the connector bucket is the follow-up.
  connector: { binding: TIERS.registered.binding, toolCalls: 20_000, providerProfiles: 300, contentReads: 3_000, notFoundPerHour: null },
} as const satisfies Record<LimitProfile, Quota>;
export const NOT_FOUND_WINDOW_SECONDS = 3_600;
export const NOT_FOUND_BLOCK_SECONDS = 3_600;

export type QuotaName = 'tool_calls' | 'provider_profiles' | 'content_reads' | 'not_found_block' | 'lookup_slots';
/** `reservedAt` identifies the not-found slots a request's lookups hold, so each settles only its own. */
export type Verdict = { ok: true; reservedAt?: number } | { ok: false; quota: QuotaName; retryAfter: number };
/** What a refusal says, and where it sends someone who needs more. */
export const REFUSALS = {
  tool_calls: { message: `Daily tool-call limit reached. For heavier use, contact Compare the Cloud: ${CONTACT_URL}`, contact: CONTACT_URL },
  provider_profiles: { message: `Daily provider-profile limit reached. For bulk directory research, use Compare the Cloud Consultant: ${CONSULTANT_URL}`, contact: CONSULTANT_URL },
  content_reads: { message: `Daily content-read limit reached. For heavier use, contact Compare the Cloud: ${CONTACT_URL}`, contact: CONTACT_URL },
  not_found_block: { message: `Too many lookups for listings or content that are not published. Tool calls resume after Retry-After. Contact: ${CONTACT_URL}`, contact: CONTACT_URL },
  lookup_slots: { message: `Too many lookups at once, or too close to the limit on lookups for unpublished records. Send fewer lookups per request and retry after Retry-After. Contact: ${CONTACT_URL}`, contact: CONTACT_URL },
} as const satisfies Record<QuotaName, { message: string; contact: string }>;

/** What a request would spend. `lookups` are the calls that can come back not found, each of which reserves
 *  a not-found slot until it settles. */
export interface Usage { toolCalls: number; providerProfiles: number; contentReads: number; lookups: number }
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
export type RpcId = string | number;
export interface Refund { providerProfiles: number; contentReads: number }
/** What one JSON-RPC body would spend, and the ids a refusal must answer. Every `tools/call` request counts,
 *  batched or not, whatever its params. A body that is not JSON, a notification and a message that is not
 *  JSON-RPC 2.0 spend nothing: the MCP transport runs no tool for any of them, so charging would only punish
 *  a broken client. The test is the SDK's own `isJSONRPCRequest`, so the two cannot disagree. */
export const callsIn = (body: string): { usage: Usage; ids: RpcId[]; batch: boolean } => {
  const usage: Usage = { toolCalls: 0, providerProfiles: 0, contentReads: 0, lookups: 0 };
  const ids: RpcId[] = [];
  const parsed = Option.getOrUndefined(parseJson(body));
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!isJSONRPCRequest(message)) continue;
    ids.push(message.id);
    if (message.method !== 'tools/call') continue;
    usage.toolCalls += 1;
    const params = Predicate.isObject(message.params) ? message.params : {};
    const charge = chargeOf(params.name, params.arguments);
    usage.providerProfiles += charge.providerProfiles; usage.contentReads += charge.contentReads; usage.lookups += charge.lookups;
  }
  return { usage, ids, batch: Array.isArray(parsed) };
};

export class QuotaUnavailable extends Schema.TaggedError<QuotaUnavailable>()('QuotaUnavailable', {}) {}
/** Spend a request's usage on the caller's daily counter. Only tool calls touch it; a failure is an error
 *  for the caller to turn into a 503, never a silent pass. */
export const enforceQuota = Effect.fn('enforceQuota')(function* (env: Env, caller: Caller, usage: Usage): Effect.fn.Return<Verdict, QuotaUnavailable> {
  if (usage.toolCalls === 0) return { ok: true };
  return yield* Effect.tryPromise({
    try: async (): Promise<Verdict> => await env.QUOTA.getByName(caller.bucket).consume(usage, QUOTAS[caller.limits]),
    catch: () => new QuotaUnavailable({}),
  });
});
/** Give back a request's charge when the transport refused it before running any tool. Dropped on error, like
 *  a settle: the cost of a lost refund is one request's worth of quota, and its reservations lapse anyway. */
export const refundQuota = (env: Env, caller: Caller, usage: Usage, reservedAt: number | undefined): Effect.Effect<void> => Effect.tryPromise(
  () => env.QUOTA.getByName(caller.bucket).refund(usage, reservedAt),
).pipe(Effect.ignore);
/** Settle a finished tool call: release its lookup's reservation (counting a miss), and give back a profile or
 *  content charge for a call that served nothing. Losing one is better than failing a tool result, so errors
 *  are dropped; an unsettled reservation frees itself within a minute. */
export const settleLookup = (env: Env, caller: Caller, missed: boolean, reservedAt: number | undefined, refund?: Refund): Effect.Effect<void> => Effect.tryPromise(
  () => env.QUOTA.getByName(caller.bucket).settleLookup(missed, QUOTAS[caller.limits], reservedAt, refund),
).pipe(Effect.ignore);
