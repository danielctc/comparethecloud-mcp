import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const version = '8.30.1';
const checksums = {
  linux_x64: '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb',
  linux_arm64: 'e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080',
  darwin_x64: 'dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709',
  darwin_arm64: 'b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5',
};
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`${command} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}${result.error ?? ''}`);
  return result.stdout;
}
let binary = 'gitleaks';
if (spawnSync(binary, ['version']).status !== 0) {
  const platform = `${process.platform}_${process.arch}`;
  assert.ok(checksums[platform], 'Install gitleaks on PATH for this platform.');
  const directory = resolve(`.cache/gitleaks-${version}`); await mkdir(directory, { recursive: true });
  binary = `${directory}/gitleaks`;
  if (spawnSync(binary, ['version']).status !== 0) {
    const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/gitleaks_${version}_${platform}.tar.gz`);
    assert.ok(response.ok, `Gitleaks download returned HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), checksums[platform], 'Gitleaks archive checksum mismatch');
    const archive = `${directory}/release.tar.gz`; await writeFile(archive, bytes);
    run('tar', ['-xzf', archive, '-C', directory, 'gitleaks']); await rm(archive);
  }
}
const files = run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean);
await mkdir('.cache', { recursive: true });
const snapshot = await mkdtemp(resolve('.cache/hygiene-'));
try {
  for (const file of new Set(files)) {
    const contents = await readFile(file);
    const destination = resolve(snapshot, file); await mkdir(dirname(destination), { recursive: true }); await cp(file, destination);
    if (/^(src|public)\//.test(file) && !file.endsWith('.png')) {
      const text = contents.toString('utf8');
      assert.ok(!/purple/i.test(text), `Disallowed colour word in ${file}`);
      for (const match of text.matchAll(/#([a-f\d]{6}|[a-f\d]{3})\b/gi)) {
        const hex = match[1].length === 3 ? [...match[1]].map(char => char + char).join('') : match[1];
        const [r, g, b] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
        const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
        if (!delta) continue;
        const hue = ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
        assert.ok(!(hue >= 260 && hue <= 330), `Disallowed colour ${match[0]} in ${file}`);
      }
    }
  }
  const output = run(binary, ['dir', snapshot, '--config', resolve('.gitleaks.toml'), '--redact', '--no-banner']);
  if (output.trim()) console.log(output.trim());
  console.log(`Gitleaks scanned ${new Set(files).size} publishable files; source and public colour checks passed.`);
  console.log('HYGIENE CHECK PASSED');
} finally {
  await rm(snapshot, { recursive: true, force: true });
}
