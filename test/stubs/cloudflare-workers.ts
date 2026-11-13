// Vitest runs in Node, where the workerd-only `cloudflare:workers` module does not exist. The Durable Object
// base class only stores ctx and env, so this stand-in lets the real QuotaCounter run against fake storage.
export class DurableObject<Env = unknown> {
  constructor(protected ctx: DurableObjectState, protected env: Env) {}
}
