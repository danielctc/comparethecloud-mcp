# Gates: leaf A — comparethecloud-mcp Worker

OWNS: **

Scope: public read-only remote MCP server for Compare the Cloud with key registration, landing page, README, server.json, tests, deployable with wrangler

- [ ] A1: typecheck, lint and unit tests pass
  CHECK: npm run check
  EXPECT: /(Tests|Test Files)\s+\d+ passed/
  EVIDENCE: pending

- [ ] A2: a dev server answers MCP initialise and lists exactly the 10 tools, each with title and readOnlyHint
  CHECK: node scripts/check-tools.mjs
  EXPECT: TOOLS CHECK PASSED
  EVIDENCE: pending

- [ ] A3: anonymous request without a key gets X-CTC-Tier anonymous, a bad key gets 401, and a seeded valid key gets X-CTC-Tier registered (dev server, local KV)
  CHECK: node scripts/check-auth.mjs
  EXPECT: AUTH CHECK PASSED
  EVIDENCE: pending

- [ ] A4: POST /register with a honeypot filled stores nothing; a valid registration stores a hashed key and calls the (mocked) email sender exactly once; the plain key never appears in KV
  CHECK: npx vitest run test/register.test.ts
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] A5: server.json validates against the vendored official registry schema
  CHECK: npx vitest run test/server-json.test.ts
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] A6: no secret or purple in the tree (gitleaks clean; no purple hex or the word purple in src/ or public/)
  CHECK: node scripts/check-hygiene.mjs
  EXPECT: HYGIENE CHECK PASSED
  EVIDENCE: pending

- [ ] A7: tool text for a missing listing says absence proves nothing, and every tool result carries the untrusted-content source note
  CHECK: npx vitest run test/tools.test.ts
  EXPECT: /Tests\s+\d+ passed/
  EVIDENCE: pending

- [ ] A8: in workerd, the provider-profile quota trips across one IPv6 /64 with a 429 and the consultant link, the next /64 is unaffected, 30 not-found lookups block an address for an hour, tools/list is exempt, and a KV deny-list address gets 403 (a stand-in www Worker answers the service binding)
  CHECK: node scripts/check-limits.mjs
  EXPECT: LIMITS CHECK PASSED
  EVIDENCE: pending
