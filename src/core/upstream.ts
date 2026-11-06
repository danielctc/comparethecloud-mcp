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
}

export const requestUpstream = Effect.fn('requestUpstream')(function* (
  context: UpstreamContext, path: string, body?: unknown,
) {
  const response = yield* Effect.tryPromise({
    try: () => fetch(new URL(path, context.env.SITE_ORIGIN), {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'User-Agent': `ctc-mcp/${version} (+https://mcp.comparethecloud.net)`,
        'X-CTC-Upstream-Secret': context.env.UPSTREAM_SECRET,
        'X-CTC-RL-Key': context.bucket,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
      ...(body === undefined ? { cf: { cacheTtl: 300 } } : {}),
    }),
    catch: () => new UpstreamError({ status: 0, message: 'Upstream request failed or timed out.' }),
  });
  if (!response.ok) {
    return yield* new UpstreamError({ status: response.status, message: `Upstream returned HTTP ${response.status}.` });
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

export const siteGuide = Effect.fn('siteGuide')(function* (context: UpstreamContext) {
  const response = yield* requestUpstream(context, '/llms.txt');
  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => new UpstreamError({ status: 0, message: 'Could not read the site guide.' }),
  });
  return { text: text.slice(0, 40_000), truncated: text.length > 40_000 };
});
