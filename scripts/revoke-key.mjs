const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
  console.error('Usage: node scripts/revoke-key.mjs <email>'); process.exit(1);
}
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
console.log(`# Review and run these commands from the repository root. No requests have been sent.
# Read the current hash, fetch the original record, and preserve its details when revoking.
ctc_key_hash=$(npx wrangler kv key get ${quote(`email:${email}`)} --binding MCP_KEYS --remote --text)
if ! printf '%s' "$ctc_key_hash" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$'; then
  echo 'No valid current key hash found.' >&2
  exit 1
fi
ctc_key_record=$(npx wrangler kv key get "key:$ctc_key_hash" --binding MCP_KEYS --remote --text)
ctc_revoked_record=$(printf '%s' "$ctc_key_record" | node --input-type=module -e 'let text = ""; for await (const part of process.stdin) text += part; const record = JSON.parse(text); if (record.status !== "active" && record.status !== "revoked") throw new Error("Invalid key record"); record.status = "revoked"; process.stdout.write(JSON.stringify(record));') || exit 1
npx wrangler kv key put "key:$ctc_key_hash" "$ctc_revoked_record" --binding MCP_KEYS --remote`);
