import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const localEnvironment = {
  ...process.env,
  WRANGLER_SEND_METRICS: 'false',
  WRANGLER_LOG_PATH: resolve('.cache/wrangler/logs'),
  WRANGLER_REGISTRY_PATH: resolve('.cache/wrangler/registry'),
  XDG_CONFIG_HOME: resolve('.cache/config'),
};
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
export function wrangler(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { env: localEnvironment, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`Wrangler failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
export async function withDevServer(run, seed = () => {}) {
  await mkdir('.cache', { recursive: true });
  const persistence = await mkdtemp(resolve('.cache/gate-'));
  let child;
  let output = '';
  try {
    await seed(persistence);
    const socket = createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    child = spawn(process.execPath, [cli, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--persist-to', persistence, '--show-interactive-dev-session=false', '--var', 'UPSTREAM_SECRET:local-gate-placeholder', '--var', 'RESEND_API_KEY:local-gate-placeholder'], {
      env: { ...localEnvironment, WRANGLER_REGISTRY_PATH: resolve(persistence, 'registry') }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const origin = `http://127.0.0.1:${port}`;
    let ready = false;
    for (let attempt = 0; attempt < 160; attempt++) {
      if (child.exitCode !== null) throw new Error(`Dev server exited:\n${output}`);
      try {
        const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) { ready = true; break; }
      } catch { /* The local listener is still starting. */ }
      await delay(250);
    }
    if (!ready) throw new Error(`Dev server did not become ready:\n${output}`);
    await run(origin);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM');
      await Promise.race([exited, delay(5000, undefined, { ref: false })]);
      if (child.exitCode === null) { child.kill('SIGKILL'); await exited; }
    }
    await rm(persistence, { recursive: true, force: true });
  }
}
export async function rpc(origin, method, params = {}, headers = {}) {
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      'Mcp-Protocol-Version': '2025-11-25', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  const data = response.headers.get('Content-Type')?.includes('text/event-stream')
    ? JSON.parse(text.split('\n').filter(line => line.startsWith('data:')).at(-1).slice(5))
    : JSON.parse(text);
  return { response, data };
}
export const initialiseParams = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'ctc-gate', version: '1.0.0' } };
