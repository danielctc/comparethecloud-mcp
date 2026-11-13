import { Effect, Schema } from 'effect';

export class BodyUnreadable extends Schema.TaggedError<BodyUnreadable>()('BodyUnreadable', {}) {}
export class BodyTooLarge extends Schema.TaggedError<BodyTooLarge>()('BodyTooLarge', {}) {}
/** Read a body up to a byte cap, so a chunked body without Content-Length is bounded as well. Past the cap
 *  the stream is cancelled rather than drained. */
export const readUpTo = Effect.fn('readUpTo')(function* (
  body: ReadableStream<Uint8Array> | null, max: number,
): Effect.fn.Return<string, BodyUnreadable | BodyTooLarge> {
  const reader = body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = yield* Effect.tryPromise({ try: () => reader.read(), catch: () => new BodyUnreadable({}) });
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      // Not awaited: cancelling one branch of a tee (a cloned request) settles only once the other branch is
      // cancelled too, which would hang the caller.
      yield* Effect.sync(() => { void reader.cancel().catch(() => undefined); });
      return yield* new BodyTooLarge({});
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
});
