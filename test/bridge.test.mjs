import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, mkdtemp, mkdir, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import {
  baseUrl, buildEvent, handlePayload, parsePayload, permissionBody,
  readPayload, relayPermission, request, sessionOf, settings,
} from '../scripts/bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const payload = (hook, extra = {}) => ({ session_id: 'parent', hook_event_name: hook, ...extra });
const config = url => ({ ...settings({}), url, timeoutMs: 300, permissionWaitMs: 400, pollMs: 5 });

async function server(t, handler) {
  const calls = [];
  const http = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const call = { method: req.method, path: req.url, body: raw ? JSON.parse(raw) : undefined };
    calls.push(call);
    try {
      await handler(call, res);
    } catch (error) {
      res.writeHead(500).end(JSON.stringify({ error: error.message }));
    }
  });
  await new Promise((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise(resolve => { http.close(resolve); http.closeAllConnections(); }));
  return { calls, url: `http://127.0.0.1:${http.address().port}` };
}
const json = (res, value, status = 200) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));

async function child(command, args, input, env = {}) {
  const proc = spawn(command, args, {
    env: { ...process.env, ...env }, windowsHide: true, cwd: tmpdir(),
    // cmd /c expects a shell command line, not Node's CRT-escaped argument list.
    windowsVerbatimArguments: command.toLowerCase().endsWith('cmd.exe'),
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', b => { stdout += b; });
  proc.stderr.on('data', b => { stderr += b; });
  proc.stdin.on('error', () => {});
  if (input !== undefined) proc.stdin.end(input);
  const timer = setTimeout(() => proc.kill(), 6000);
  try {
    const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

test('loopback origins only; reject credentials, paths, queries and remote hosts', () => {
  assert.equal(baseUrl(), 'http://127.0.0.1:8765');
  assert.equal(baseUrl('http://[::1]:8765/'), 'http://[::1]:8765');
  assert.equal(baseUrl('http://localhost:8123'), 'http://localhost:8123');
  for (const url of ['http://example.com', 'http://127.0.0.1.evil.test', 'file:///tmp/x', 'http://a:b@localhost', 'http://localhost/event', 'http://localhost/?x=1', 'http://localhost/#x']) {
    assert.throws(() => baseUrl(url));
  }
});

test('configuration bounds keep requests within Codex shutdown budgets', () => {
  assert.equal(settings({}).permissionMode, 'relay');
  assert.equal(settings({ AT_PET_PERMISSION_MODE: 'notify' }).permissionMode, 'notify');
  for (const env of [{ AT_PET_TIMEOUT_MS: '2001' }, { AT_PET_PERMISSION_WAIT_MS: '600000' }, { AT_PET_TIMEOUT_MS: 'NaN' }, { AT_PET_PERMISSION_MODE: 'allow' }]) {
    assert.throws(() => settings(env));
  }
});

for (const [hook, event] of Object.entries({ UserPromptSubmit: 'thinking', PreModelRequest: 'thinking', PreToolUse: 'tool_start', PostToolUse: 'tool_end', Stop: 'done', Interrupt: 'cancelled', SessionEnd: 'session_end', SubagentStart: 'thinking', SubagentStop: 'done', PreCompact: 'thinking', PostCompact: 'thinking', PermissionRequest: 'permission' })) {
  test(`${hook} maps to ${event}`, () => assert.equal(buildEvent(payload(hook)).event, event));
}

test('model completion is not task completion; model failures/cancellation are mapped', () => {
  assert.equal(buildEvent(payload('PostModelRequest', { status: 'completed' })), null);
  assert.equal(buildEvent(payload('PostModelRequest', { status: 'failed' })).event, 'error');
  assert.equal(buildEvent(payload('PostModelRequest', { status: 'cancelled' })).event, 'cancelled');
  assert.equal(buildEvent(payload('SessionStart', { source: 'compact' })), null);
  assert.equal(buildEvent(payload('not-a-hook')), null);
  assert.equal(buildEvent(payload('constructor')), null);
  assert.equal(buildEvent(payload('__proto__')), null);
});

test('structured tool failures; never classify arbitrary tool output text', () => {
  for (const tool_response of [{ isError: true }, { success: false }, { exit_code: 1 }, { exitCode: 2 }, { status: 'failed' }]) {
    assert.equal(buildEvent(payload('PostToolUse', { tool_response })).event, 'error');
  }
  for (const tool_response of ['error example', { exit_code: 0 }, { exit_code: '2' }, null]) {
    assert.equal(buildEvent(payload('PostToolUse', { tool_response })).event, 'tool_end');
  }
});

test('child lifecycle and model hooks share child id and preserve parent id', () => {
  const a = buildEvent(payload('SubagentStart', { agent_id: 'child-a' }));
  const b = buildEvent(payload('SubagentStop', { agent_id: 'child-b' }));
  const model = buildEvent(payload('PreModelRequest', { agent_id: 'child-a' }));
  assert.equal(a.sessionId, model.sessionId);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal(a.parentSessionId, 'parent');
  assert.equal(a.isSubagent, true);
  assert.equal(sessionOf({}), null);
  assert.equal(buildEvent({ hook_event_name: 'Stop' }), null);
});

test('events do not forward prompt, commands, output, or transcript paths', () => {
  const event = buildEvent(payload('PreToolUse', { prompt: 'secret', transcript_path: '/secret', tool_input: { command: 'secret' }, tool_response: 'secret', tool_name: 'Bash', model: 'model-id' }));
  assert.ok(!JSON.stringify(event).includes('secret'));
  assert.equal(event.toolName, 'Bash');
  assert.equal(event.model, 'model-id');
});

test('permission descriptions cover cmd, command and MCP arguments', () => {
  assert.match(permissionBody(payload('PermissionRequest', { tool_name: 'Bash', tool_input: { cmd: 'npm test', description: 'Run tests' } })).description, /npm test/);
  assert.match(permissionBody(payload('PermissionRequest', { tool_name: 'mcp__fs__write', tool_input: { path: '/test', data: 'abc' } })).description, /"path"/);
  const long = permissionBody(payload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'x'.repeat(4000) } }));
  assert.ok(long.description.length <= 2000);
  assert.match(long.description, /已截断/);
  assert.equal(permissionBody(payload('PermissionRequest')), null);
});

test('stdin accepts BOM and empty object; invalid JSON/arrays are rejected', async () => {
  assert.deepEqual(parsePayload('\uFEFF {}'), {});
  for (const raw of ['null', '[]', '{']) assert.throws(() => parsePayload(raw));
  const input = new PassThrough();
  const promise = readPayload(input);
  input.end(JSON.stringify(payload('Stop')));
  assert.equal((await promise).hook_event_name, 'Stop');
});

test('stdin size and time limits are enforced', async () => {
  const input = new PassThrough();
  const result = readPayload(input);
  input.end('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(result, /exceeds/);
  await assert.rejects(readPayload(new PassThrough(), 20), /timed out/);
});

test('HTTP event POST follows At-Pet contract and returns no hook output', async t => {
  const mock = await server(t, (_req, res) => json(res, { accepted: true }, 202));
  assert.equal(await handlePayload(payload('PreToolUse', { tool_name: 'Bash' }), config(mock.url)), null);
  assert.deepEqual(mock.calls, [{ method: 'POST', path: '/event', body: { sessionId: 'parent', isSubagent: false, parentSessionId: '', agentApp: 'openai-codex', event: 'tool_start', toolName: 'Bash', message: 'Bash' } }]);
});

for (const [status, behavior] of [['allowed_once', 'allow'], ['denied', 'deny']]) {
  test(`permission ${status} returns only explicit ${behavior}`, async t => {
    let polls = 0;
    const mock = await server(t, (req, res) => {
      if (req.method === 'POST') return json(res, { requestId: 'r1', status: 'pending' }, 202);
      json(res, { status: ++polls === 1 ? 'pending' : status });
    });
    const answer = await relayPermission(payload('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test' } }), config(mock.url));
    assert.equal(answer.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.equal(answer.hookSpecificOutput.decision.behavior, behavior);
    assert.equal(mock.calls[0].body.agentApp, 'openai-codex');
    assert.equal(mock.calls.filter(c => c.method === 'DELETE').length, 0);
  });
}

test('permission timeout cancels stale popup and delegates to Codex', async t => {
  const mock = await server(t, (req, res) => json(res, req.method === 'POST' ? { requestId: 'timeout' } : { status: 'pending' }));
  assert.equal(await relayPermission(payload('PermissionRequest', { tool_name: 'Bash' }), { ...config(mock.url), permissionWaitMs: 30 }), null);
  assert.ok(mock.calls.some(c => c.method === 'DELETE' && c.path === '/permission/timeout'));
});

for (const status of ['allowed', 'true', 'cancelled', '', null, 'constructor', '__proto__']) {
  test(`unknown permission status ${JSON.stringify(status)} never approves`, async t => {
    const mock = await server(t, (req, res) => json(res, req.method === 'POST' ? { requestId: 'unknown' } : { status }));
    assert.equal(await relayPermission(payload('PermissionRequest', { tool_name: 'Bash' }), config(mock.url)), null);
    assert.equal(mock.calls.at(-1).method, 'DELETE');
  });
}

test('permission polling HTTP failure is cleaned up without a decision', async t => {
  const mock = await server(t, (req, res) => json(res, req.method === 'POST' ? { requestId: 'err' } : {}, req.method === 'GET' ? 500 : 200));
  assert.equal(await relayPermission(payload('PermissionRequest', { tool_name: 'Bash' }), config(mock.url)), null);
  assert.equal(mock.calls.at(-1).method, 'DELETE');
});

test('permission abort cleans pending request', async t => {
  const controller = new AbortController();
  const mock = await server(t, (req, res) => {
    json(res, req.method === 'POST' ? { requestId: 'abort' } : { status: 'pending' });
    if (req.method === 'GET') controller.abort();
  });
  assert.equal(await relayPermission(payload('PermissionRequest', { tool_name: 'Bash' }), config(mock.url), controller.signal), null);
  assert.equal(mock.calls.at(-1).method, 'DELETE');
});

test('notify mode sends only event and leaves Codex approval intact', async t => {
  const mock = await server(t, (_req, res) => json(res, { accepted: true }));
  assert.equal(await handlePayload(payload('PermissionRequest', { tool_name: 'Bash' }), { ...config(mock.url), permissionMode: 'notify' }), null);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].path, '/event');
  assert.equal(mock.calls[0].body.event, 'permission');
});

test('redirects are rejected; stalled response bodies time out', async t => {
  const mock = await server(t, (req, res) => {
    if (req.path === '/redirect') res.writeHead(302, { Location: '/event' }).end();
    else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.flushHeaders(); }
  });
  await assert.rejects(request(config(mock.url), '/redirect'));
  await assert.rejects(request({ ...config(mock.url), timeoutMs: 40 }, '/stall'));
  assert.ok(!mock.calls.some(c => c.path === '/event'));
});

test('real hook subprocess fails silently for malformed input and unavailable At-Pet', async () => {
  const args = [join(root, 'scripts/bridge.mjs')];
  assert.deepEqual(await child(process.execPath, args, '{', { AT_PET_DEBUG: '' }), { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(await child(process.execPath, args, JSON.stringify(payload('Stop')), { AT_PET_URL: 'http://127.0.0.1:1', AT_PET_DEBUG: '' }), { code: 0, stdout: '', stderr: '' });
});

test('real permission subprocess stdout contains exactly one Codex decision', async t => {
  const mock = await server(t, (req, res) => json(res, req.method === 'POST' ? { requestId: 'process' } : { status: 'allowed_once' }));
  const result = await child(process.execPath, [join(root, 'scripts/bridge.mjs')], JSON.stringify(payload('PermissionRequest', { tool_name: 'Bash' })), { AT_PET_URL: mock.url, AT_PET_PERMISSION_MODE: 'relay' });
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.decision.behavior, 'allow');
  assert.equal(result.stderr, '');
});

test('packaged hook command launches from arbitrary cwd and special-character plugin path on Windows', { skip: process.platform !== 'win32' }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'at-pet-hook-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const pluginRoot = join(temporary, '插件 space $dollar `tick');
  await mkdir(pluginRoot);
  await cp(join(root, 'scripts'), join(pluginRoot, 'scripts'), { recursive: true });
  const hookConfig = JSON.parse(await readFile(join(root, 'hooks/hooks.json'), 'utf8'));
  const command = hookConfig.hooks.UserPromptSubmit[0].hooks[0].commandWindows;
  const mock = await server(t, (_req, res) => json(res, { accepted: true }));
  let expectedCalls = 0;
  for (const [shell, args] of [['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]], ['cmd.exe', ['/d', '/s', '/c', command]]]) {
    const result = await child(shell, args, JSON.stringify(payload('UserPromptSubmit')), { PLUGIN_ROOT: pluginRoot, AT_PET_URL: mock.url });
    assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
    assert.equal(mock.calls.length, ++expectedCalls, `${shell} must deliver hook stdin`);
  }
  assert.equal(mock.calls.length, 2);
  assert.ok(mock.calls.every(c => c.body.event === 'thinking'));
});
