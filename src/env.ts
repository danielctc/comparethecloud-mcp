export interface Env {
  MCP_KEYS: KVNamespace;
  RL_ANON: RateLimit;
  RL_KEY: RateLimit;
  ASSETS: Fetcher;
  /** Service binding to the www Worker; a plain fetch to the same zone would bypass it. Required: a missing
   *  binding must fail loudly, never fall back to the bypassing path. Tests inject a fetcher. */
  SITE: Fetcher;
  SITE_ORIGIN: string;
  PUBLIC_ORIGIN: string;
  RESEND_FROM: string;
  RESEND_API_KEY: string;
  UPSTREAM_SECRET: string;
  OPENAI_APPS_CHALLENGE?: string;
}

/** Public site; every upstream URL and every link in tool output derives from it. */
export const SITE_URL = 'https://www.comparethecloud.net';
/** One table drives the limiter binding, the advertised policy, the page copy and Retry-After for both tiers.
 *  The limit and window must match the ratelimit bindings in wrangler.jsonc; test/manifests.test.ts checks that. */
const tier = <B extends 'RL_ANON' | 'RL_KEY'>(binding: B, limit: number, window: number) =>
  ({ binding, limit, window, policy: `${limit};w=${window}` }) as const;
export const TIERS = {
  anonymous: tier('RL_ANON', 60, 60),
  registered: tier('RL_KEY', 600, 60),
} as const;
export type Tier = keyof typeof TIERS;

export interface Caller {
  bucket: string;
  tier: Tier;
}
