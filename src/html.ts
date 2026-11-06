import { toolTitles } from './core/tools';
import { SITE_URL as SITE, TIERS } from './env';

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
export function page(title: string, body: string): string {
  return `<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>
:root{color-scheme:light;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#0F172A;background:#F1F5F9}*{box-sizing:border-box}body{margin:0}main{max-width:1100px;margin:auto;padding:24px 16px}h1{font-size:clamp(2rem,5vw,3rem);margin:12px 0}h2{font-size:1.2rem;margin-top:24px}p{line-height:1.6}a{color:#286D9D}header img{width:140px;max-width:100%;height:auto}.intro{color:#475569;max-width:76ch}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,290px),1fr));gap:16px}section,form{background:white;padding:20px;border-radius:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#F1F5F9;padding:12px;font-size:.85rem}code{overflow-wrap:anywhere}.button,button{display:inline-block;background:#286D9D;color:white;border:0;border-radius:5px;padding:12px 18px;font:inherit;text-decoration:none}label{display:block;margin-top:18px}input:not([type=checkbox]),textarea{display:block;width:100%;font:inherit;padding:10px;border:1px solid #475569;border-radius:4px;margin-top:6px}textarea{min-height:120px}input[type=checkbox]{width:20px;height:20px;vertical-align:middle}button{margin-top:20px;cursor:pointer}footer{margin-top:28px;color:#475569}footer a{margin-right:16px}li{margin:8px 0}.tools{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));column-gap:24px}form{max-width:640px}.notice{padding:12px;border-left:4px solid #286D9D}
</style></head><body><main><header><a href="/"><img src="/logo.png" alt="Compare the Cloud"></a></header>${body}<footer><p><a href="${SITE}/privacy-policy">Privacy policy</a><a href="${SITE}/terms-and-conditions">Terms</a><a href="${SITE}/contact">Contact</a><a href="https://github.com/danielctc/comparethecloud-mcp">GitHub</a></p></footer></main></body></html>`;
}
export function landing(origin: string): string {
  const endpoint = `${origin}/mcp`;
  const snippets = [
    ['Claude.ai', `Settings → Connectors → Add custom connector → URL\n${endpoint}`],
    ['Claude Code', `claude mcp add --transport http comparethecloud ${endpoint}`],
    ['Cursor · .cursor/mcp.json', JSON.stringify({ mcpServers: { comparethecloud: { url: endpoint } } }, null, 2)],
    ['Codex CLI', `codex mcp add comparethecloud --url ${endpoint}`],
    ['ChatGPT', `Developer mode → connectors → URL\n${endpoint}`],
    ['Local stdio', `npx mcp-remote ${endpoint}`],
  ];
  return page('Compare the Cloud MCP', `<h1>Compare the Cloud MCP</h1><p class="intro">Read-only access to a UK B2B technology provider directory of more than 20,000 listings, plus articles, news and opinion from Compare the Cloud, publishing since 2012.</p><p><strong>Endpoint</strong> <code>${escapeHtml(endpoint)}</code></p><p>Works without a key (${TIERS.anonymous.limit} req/min); register for a free key (${TIERS.registered.limit} req/min).</p><p><a class="button" href="/register">Get a free key</a></p><h2>Connect your assistant</h2><div class="grid">${snippets.map(([title, snippet]) => `<section><h2>${title}</h2><pre>${escapeHtml(snippet)}</pre></section>`).join('')}</div><h2>Read-only tools</h2><ul class="tools">${Object.entries(toolTitles).map(([name, title]) => `<li><code>${name}</code> — ${title}.</li>`).join('')}</ul>`);
}
export function registrationForm(message = ''): string {
  return page('Register · Compare the Cloud MCP', `<h1>Get a free MCP key</h1><p>${TIERS.registered.limit} requests per minute. Your key will be sent by email.</p>${message ? `<p class="notice" role="alert">${escapeHtml(message)}</p>` : ''}<form method="post" action="/register"><label>Name<input name="name" autocomplete="name" minlength="2" maxlength="80" required></label><label>Work email<input type="email" name="email" autocomplete="email" maxlength="254" required></label><label>Organisation (optional)<input name="org" autocomplete="organization" maxlength="200"></label><label>What are you building?<textarea name="use" minlength="10" maxlength="500" required></textarea></label><div hidden aria-hidden="true"><label>Website<input name="website" tabindex="-1" autocomplete="off"></label></div><label><input type="checkbox" name="terms" value="yes" required> I agree to the <a href="${SITE}/terms-and-conditions">terms and conditions</a> and <a href="${SITE}/privacy-policy">privacy policy</a>.</label><button type="submit">Email my key</button></form>`);
}
export const registrationSuccess = () => page('Check your email · Compare the Cloud MCP', '<h1>Check your email</h1><p>Your MCP key has been emailed to you. Please check your inbox and spam folder.</p>');
export const registrationFailure = () => page('Email unavailable · Compare the Cloud MCP', '<h1>Could not send, try again later</h1><p>We could not email your MCP key. Please try again later.</p>');
