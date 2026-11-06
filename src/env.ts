export interface Env {
  MCP_KEYS: KVNamespace;
  RL_ANON: RateLimit;
  RL_KEY: RateLimit;
  ASSETS: Fetcher;
  SITE_ORIGIN: string;
  PUBLIC_ORIGIN: string;
  RESEND_FROM: string;
  RESEND_API_KEY: string;
  UPSTREAM_SECRET: string;
}

export interface Caller {
  bucket: string;
  tier: 'anonymous' | 'registered';
  policy: string;
}
