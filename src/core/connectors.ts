import { Clock, Effect, Option, Predicate, Schema } from 'effect';
import type { Env } from '../env';
import { readUpTo } from './body';
import { parseCidr, type Cidr } from './ip';
import { readJson, storage } from './keys';

/**
 * Hosted connectors call from their vendor's shared addresses, so every anonymous user of one connector would
 * otherwise share one 60-a-minute bucket. Addresses in these ranges get the connector limits instead.
 *
 * Anthropic: the Claude docs IP page (https://platform.claude.com/docs/en/api/ip-addresses) lists both ranges for
 * "MCP connector, web search, and web fetch"; the connector auth page names only the first. Both are kept.
 * Checked 13 November 2026.
 */
export const ANTHROPIC_CONNECTOR_RANGES = ['160.79.104.0/21', '153.61.208.0/20'] as const;
const STATIC = ANTHROPIC_CONNECTOR_RANGES.map(parseCidr).filter(Predicate.isNotNull);

// OpenAI publishes its ranges as a JSON manifest and says they change, so it is read at runtime
// (OPENAI_CONNECTOR_RANGES_URL) and held for a day. The last good list is kept in KV, so a new isolate starts
// with it instead of demoting ChatGPT callers, and a failed refresh keeps it rather than dropping to nothing.
// With no good list ever fetched, OpenAI addresses get anonymous limits: the safe direction for a list that
// grants larger ones.
const FRESH_MS = 86_400_000;
const RETRY_MS = 300_000;
// How long a last good list may stand in for failed refreshes before OpenAI addresses fall back to anonymous.
const STALE_LIMIT_MS = 3 * FRESH_MS;
const MAX_BYTES = 512_000;
const MAX_PREFIXES = 5_000;
const STORE_KEY = 'connectors:openai';
// A manifest entry broader than this is a mistake or a tampered file, never one vendor's egress.
const NARROWEST = { 4: 16, 6: 32 } as const;
const Manifest = Schema.Struct({ prefixes: Schema.Array(Schema.Struct({
  ipv4Prefix: Schema.optional(Schema.String), ipv6Prefix: Schema.optional(Schema.String),
})).check(Schema.isMaxLength(MAX_PREFIXES)) });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const Stored = Schema.Struct({ fetchedAt: Schema.Number, prefixes: Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_PREFIXES)) });

class ManifestUnavailable extends Schema.TaggedError<ManifestUnavailable>()('ManifestUnavailable', {}) {}
const usable = (prefix: string) => {
  const range = parseCidr(prefix);
  return range !== null && range.bits >= NARROWEST[range.version] ? range : null;
};
/** The static ranges plus OpenAI's, merged once per load rather than on every request. */
const merged = (prefixes: readonly string[]) => [...STATIC, ...prefixes.map(usable).filter(Predicate.isNotNull)];

interface Loaded { ranges: readonly Cidr[]; until: number; fetchedAt: number }
let openai: Loaded | undefined;
let refreshing = false;
/** Tests start each case with an empty isolate. */
export const resetConnectorCache = () => { openai = undefined; refreshing = false; };

const fetchManifest = Effect.fn('fetchManifest')(function* (url: string): Effect.fn.Return<string[], ManifestUnavailable> {
  const unavailable = () => new ManifestUnavailable({});
  const response = yield* Effect.tryPromise({
    try: () => fetch(url, { signal: AbortSignal.timeout(5_000), headers: { Accept: 'application/json' } }), catch: unavailable,
  });
  if (!response.ok) {
    yield* Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());
    return yield* unavailable();
  }
  const text = yield* readUpTo(response.body, MAX_BYTES).pipe(Effect.mapError(unavailable));
  const manifest = yield* decodeManifest(text).pipe(Effect.mapError(unavailable));
  const prefixes = manifest.prefixes.flatMap(entry => [entry.ipv4Prefix, entry.ipv6Prefix])
    .filter(Predicate.isString).filter(prefix => usable(prefix) !== null);
  // An empty list is a broken manifest, not OpenAI giving up its connectors.
  if (prefixes.length === 0) return yield* unavailable();
  return prefixes;
});

const refresh = Effect.fn('refreshConnectorRanges')(function* (env: Env, url: string, now: number) {
  const fetched = yield* fetchManifest(url).pipe(Effect.option);
  if (Option.isNone(fetched)) {
    // Deny on error: no new ranges are granted. A last good list stands for up to three days, then nothing does.
    const lastGood = openai && now - openai.fetchedAt < STALE_LIMIT_MS ? openai : undefined;
    openai = { ranges: lastGood?.ranges ?? STATIC, until: now + RETRY_MS, fetchedAt: lastGood?.fetchedAt ?? 0 };
    return;
  }
  openai = { ranges: merged(fetched.value), until: now + FRESH_MS, fetchedAt: now };
  // Losing this write only costs the next new isolate a fetch, so a KV failure is dropped. The copy expires
  // with the stale limit, so a manifest that stays unreachable ends in no OpenAI ranges everywhere.
  yield* storage(() => env.MCP_KEYS.put(STORE_KEY, JSON.stringify({ fetchedAt: now, prefixes: fetched.value }),
    { expirationTtl: STALE_LIMIT_MS / 1_000 })).pipe(Effect.ignore);
});

/** The ranges that earn connector limits right now. Never waits on openai.com: a stale list is refreshed in
 *  the background through `waitUntil`, one refresh at a time per isolate. A new isolate reads KV once. */
export const connectorRanges = Effect.fn('connectorRanges')(function* (env: Env, waitUntil: (promise: Promise<unknown>) => void) {
  const url = env.OPENAI_CONNECTOR_RANGES_URL;
  if (!url) return STATIC;
  const now = yield* Clock.currentTimeMillis;
  if (!openai) {
    const stored = yield* readJson(env, STORE_KEY, Stored).pipe(Effect.option, Effect.map(Option.getOrNull));
    openai ??= stored
      ? { ranges: merged(stored.prefixes), until: stored.fetchedAt + FRESH_MS, fetchedAt: stored.fetchedAt }
      : { ranges: STATIC, until: 0, fetchedAt: 0 };
  }
  if (now >= openai.until && !refreshing) {
    refreshing = true;
    waitUntil(Effect.runPromise(refresh(env, url, now).pipe(Effect.ensuring(Effect.sync(() => { refreshing = false; })))));
  }
  return openai.ranges;
});
