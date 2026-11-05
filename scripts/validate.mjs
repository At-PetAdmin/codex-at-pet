import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const json = async path => JSON.parse(await readFile(resolve(root, path), 'utf8'));
const manifest = await json('plugin.json');
const compat = await json('.codex-plugin/plugin.json');
const catalog = await json('.claude-plugin/marketplace.json');
const pkg = await json('package.json');
assert.equal(manifest.name, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(compat.name, manifest.name);
assert.equal(compat.version, manifest.version);
assert.equal(catalog.plugins[0].name, manifest.name);
assert.equal(catalog.plugins[0].source.path, './');
const hookPath = manifest.extensions['com.openai'].hooks;
assert.equal(hookPath, compat.hooks);
const hooks = (await json(hookPath)).hooks;
for (const [event, groups] of Object.entries(hooks)) {
  for (const group of groups) for (const hook of group.hooks) {
    assert.equal(hook.type, 'command');
    assert.equal(hook.command, hook.commandWindows);
    assert.ok(hook.command.includes('process.env.PLUGIN_ROOT'));
    assert.ok(hook.command.includes('bridge.mjs'));
    assert.ok(hook.timeout <= (['SessionEnd', 'Interrupt'].includes(event) ? 3 : 600));
    assert.ok(!hook.async, 'Preserve event order and wait for permission decisions');
  }
}
assert.ok(hooks.PermissionRequest);
assert.ok(hooks.Interrupt);
assert.ok(!hooks.PostToolUseFailure, 'Use current Codex events, not Claude-only hooks');
await access(resolve(root, 'scripts/bridge.mjs'));
console.log(`Validated ${manifest.name}@${manifest.version}: ${Object.keys(hooks).length} hook events and marketplace metadata.`);
