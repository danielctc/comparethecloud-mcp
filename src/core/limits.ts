import { Effect, Option, Predicate, Schema } from 'effect';
import { SITE_URL, TIERS, type Caller, type Env } from '../env';
import type { ToolName } from './tools';

export const CONTACT_URL = `${SITE_URL}/contact`;
export const CONSULTANT_URL = `${SITE_URL}/consultant`;

/** Which limits a caller gets. A connector address is an anonymous tier caller with a larger, shared allowance. */
export type LimitProfile = 'anonymous' | 'connector' | 'registered';
export interface Quota {
  /** The per-minute ratelimit binding. */
  binding: 'RL_ANON' | 'RL_KEY';
  /** Per UTC day. */
  toolCalls: number; providerProfiles: number; contentReads: number;
  /** Not-found lookups allowed in an hour before tool calls are blocked for an hour. */
  notFoundPerHour: number;
}
/** Every number the abuse limits use. Plan: comparethecloud-mcp-oauth-plan-v1.md section 2, with Daniel's
 *  13 November 2026 change to provider profiles (30 anonymous, 150 signed in). */
export const QUOTAS = {
  anonymous: { binding: TIERS.anonymous.binding, toolCalls: 2_000, providerProfiles: 30, contentReads: 300, notFoundPerHour: 30 },
  registered: { binding: TIERS.registered.binding, toolCalls: 10_000, providerProfiles: 150, contentReads: 2_000, notFoundPerHour: 30 },
  // One connector address carries many people, so it gets 600 a minute and 20,000 calls a day (plan section 2).
  // The plan sets no profile, content or not-found numbers for it: these are the anonymous ones scaled 10x
  // like the call limits, pending Daniel's decision. The anonymous 30 would lock out everyone behind the address.
  connector: { binding: TIERS.registered.binding, toolCalls: 20_000, providerProfiles: 300, contentReads: 3_000, notFoundPerHour: 300 },
} as const satisfies Record<LimitProfile, Quota>;
export const NOT_FOUND_WINDOW_SECONDS = 3_600;
export const NOT_FOUND_BLOCK_SECONDS = 3_600;

export type QuotaName = 'tool_calls' | 'provider_profiles' | 'content_reads' | 'not_found_block';
export type Verdict = { ok: true } | { ok: false; quota: QuotaName; retryAfter: number };
/** What a refusal says, and where it sends someone who needs more. */
export const REFUSALS = {
  tool_calls: { message: `Daily tool-call limit reached. For heavier use, contact Compare the Cloud: ${CONTACT_URL}`, contact: CONTACT_URL },
  provider_profiles: { message: `Daily provider-profile limit reached. For bulk directory research, use Compare the Cloud Consultant: ${CONSULTANT_URL}`, contact: CONSULTANT_URL },
  content_reads: { message: `Daily content-read limit reached. For heavier use, contact Compare the Cloud: ${CONTACT_URL}`, contact: CONTACT_URL },
  not_found_block: { message: `Too many lookups for listings or content that are not published. Tool calls resume after Retry-After. Contact: ${CONTACT_URL}`, contact: CONTACT_URL },
} as const satisfies Record<QuotaName, { message: string; contact: string }>;

/** What a request would spend. `lookups` are the calls that can come back not found, each of which reserves
 *  a not-found slot until it settles. */
export interface Usage { toolCalls: number; providerProfiles: number; contentReads: number; lookups: number }
/** The tools that look one record up by slug or id: a run of misses from them is how slugs get guessed. */
export const LOOKUP_TOOLS: ReadonlySet<string> = new Set<ToolName>(['get_provider', 'similar_providers', 'get_content', 'fetch']);
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const CONTENT_TYPES = new Set(['article', 'news', 'opinion']);
const PROFILE_TOOL: ToolName = 'get_provider';
const CONTENT_TOOL: ToolName = 'get_content';
const FETCH_TOOL: ToolName = 'fetch';
/** What one JSON-RPC body would spend. Every `tools/call` counts, batched or not, whatever its params; an
 *  unparseable body spends nothing because the MCP handler refuses it with a parse error. */
export const usageOf = (body: string): Usage => {
  const usage: Usage = { toolCalls: 0, providerProfiles: 0, contentReads: 0, lookups: 0 };
  const parsed = Option.getOrUndefined(parseJson(body));
  for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!Predicate.isObject(message) || message.method !== 'tools/call') continue;
    usage.toolCalls += 1;
    const params = Predicate.isObject(message.params) ? message.params : {};
    const args = Predicate.isObject(params.arguments) ? params.arguments : {};
    const fetched = params.name === FETCH_TOOL && Predicate.isString(args.id) ? args.id.split(':')[0] : undefined;
    if (params.name === PROFILE_TOOL || fetched === 'provider') usage.providerProfiles += 1;
    if (params.name === CONTENT_TOOL || (fetched !== undefined && CONTENT_TYPES.has(fetched))) usage.contentReads += 1;
    if (Predicate.isString(params.name) && LOOKUP_TOOLS.has(params.name)) usage.lookups += 1;
  }
  return usage;
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
/** Settle a lookup's reservation, counting it if it missed. Losing one is better than failing a tool result,
 *  so errors are dropped; an unsettled reservation frees itself within a minute. */
export const settleLookup = (env: Env, caller: Caller, missed: boolean): Effect.Effect<void> => Effect.tryPromise(
  () => env.QUOTA.getByName(caller.bucket).settleLookup(missed, QUOTAS[caller.limits]),
).pipe(Effect.ignore);
