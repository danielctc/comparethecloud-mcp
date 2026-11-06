import { Effect, Schema } from 'effect';
import { version } from '../../package.json';
import type { Env } from '../env';

export class UpstreamError extends Schema.TaggedError<UpstreamError>()('UpstreamError', {
  status: Schema.Number,
  message: Schema.String,
}) {}

export interface UpstreamContext {
  env: Env;
  bucket: string;
  /** Keeps a cache write alive after the response is sent; absent in tests. */
  waitUntil?: (promise: Promise<unknown>) => void;
}

// A service-binding fetch bypasses the Cloudflare edge cache, so GETs are cached here explicitly.
// The Cache API honours the www Cache-Control header, which is the one place the TTL is decided.
const edgeCache = (): Cache | undefined => (globalThis as { caches?: CacheStorage }).caches?.default;

export const requestUpstream = Effect.fn('requestUpstream')(function* (
  context: UpstreamContext, path: string, body?: unknown,
) {
  const url = new URL(path, context.env.SITE_ORIGIN);
  const cache = body === undefined ? edgeCache() : undefined;
  // Keyed under this Worker's own hostname on a path it never serves, so an entry can never be confused
  // with the www zone's own CDN cache for the same public URL.
  const cacheKey = new URL(`/__upstream${url.pathname}${url.search}`, context.env.PUBLIC_ORIGIN);
  const cached = cache ? yield* Effect.promise(() => cache.match(cacheKey).catch(() => undefined)) : undefined;
  if (cached) return cached;
  // Through the service binding: a plain fetch to the same zone would skip the www Worker.
  const response = yield* Effect.tryPromise({
    try: () => context.env.SITE.fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'User-Agent': `ctc-mcp/${version} (+https://mcp.comparethecloud.net)`,
        'X-CTC-Upstream-Secret': context.env.UPSTREAM_SECRET,
        'X-CTC-RL-Key': context.bucket,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: 'manual',
    }),
    catch: () => new UpstreamError({ status: 0, message: 'Upstream request failed or timed out.' }),
  });
  if (!response.ok) {
    return yield* new UpstreamError({ status: response.status, message: `Upstream returned HTTP ${response.status}.` });
  }
  // Only successes are stored; a transient 404 or 5xx must never be served for the TTL.
  if (cache) {
    const stored = cache.put(cacheKey, response.clone()).catch(() => undefined);
    context.waitUntil?.(stored);
  }
  return response;
});

export const upstreamJson = Effect.fn('upstreamJson')(function* <S extends Schema.Constraint>(
  context: UpstreamContext, path: string, schema: S, body?: unknown,
) {
  const response = yield* requestUpstream(context, path, body);
  const value = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: () => new UpstreamError({ status: 0, message: 'Upstream returned invalid JSON.' }),
  });
  return yield* Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new UpstreamError({ status: 0, message: 'Upstream returned an unexpected response shape.' })),
  );
});

/** Cut text at a limit and say so; the one truncation rule for every tool. */
export const truncate = (text: string, max: number) => ({ text: text.slice(0, max), truncated: text.length > max });

// The site guide is cached like every other GET, for as long as www says (an hour at the time of writing).
export const siteGuide = Effect.fn('siteGuide')(function* (context: UpstreamContext) {
  const response = yield* requestUpstream(context, '/llms.txt');
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new UpstreamError({ status: 0, message: 'Could not read the site guide.' }),
  });
  return truncate(text, 40_000);
});
