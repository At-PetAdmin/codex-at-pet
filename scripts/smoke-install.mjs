// Installs only into a fresh temporary Codex home, then removes that directory.
// The user's real Codex settings, plugins and trust records are untouched.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'codex-at-pet-install-'));
async function codex(args) {
  const proc = spawn('codex', args, {
    cwd: root, windowsHide: true,
    env: { ...process.env, CODEX_HOME: temporary },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', error = '';
  proc.stdout.on('data', chunk => { output += chunk; });
  proc.stderr.on('data', chunk => { error += chunk; });
  const timer = setTimeout(() => proc.kill(), 20000);
  try {
    const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
    if (code !== 0) throw new Error(`${args.join(' ')} failed: ${error || output}`);
    console.log(output.trim());
    return output;
  } finally { clearTimeout(timer); }
}
try {
  await codex(['plugin', 'marketplace', 'add', root, '--json']);
  const installed = JSON.parse(await codex(['plugin', 'add', 'codex-at-pet@at-pet-local', '--json']));
  const hooks = JSON.parse(await readFile(join(installed.installedPath, 'hooks/hooks.json'), 'utf8'));
  assert.equal(Object.keys(hooks.hooks).length, 14);
  await readFile(join(installed.installedPath, 'scripts/bridge.mjs'), 'utf8');
  const installedConfig = await readFile(join(temporary, 'config.toml'), 'utf8');
  assert.match(installedConfig, /codex-at-pet/);
  console.log('Codex accepted the local marketplace and installed the plugin in an isolated temporary home.');
} finally {
  await rm(temporary, { recursive: true, force: true });
}
