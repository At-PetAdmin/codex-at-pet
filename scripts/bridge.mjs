// Protocol inspired by At-Pet's MIT-licensed OpenAI Codex integration.
// No transcript or prompt is read; only the current hook JSON is consumed.
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const AGENT_APP = 'openai-codex';
const MAX_INPUT_BYTES = 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 256) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const EVENTS = new Map(Object.entries({
  UserPromptSubmit: 'thinking', PreModelRequest: 'thinking',
  PreToolUse: 'tool_start', PostToolUse: 'tool_end',
  Stop: 'done', Interrupt: 'cancelled', SessionEnd: 'session_end',
  SubagentStart: 'thinking', SubagentStop: 'done',
  PreCompact: 'thinking', PostCompact: 'thinking', PermissionRequest: 'permission',
}));

export function baseUrl(value = 'http://127.0.0.1:8765') {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('AT_PET_URL must be a loopback HTTP(S) origin, e.g. http://127.0.0.1:8765');
  }
  return url.origin;
}

function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Timing setting must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

export function settings(env = process.env) {
  const permissionMode = env.AT_PET_PERMISSION_MODE || 'relay';
  if (!['relay', 'notify'].includes(permissionMode)) throw new Error('AT_PET_PERMISSION_MODE must be relay or notify');
  return {
    url: baseUrl(env.AT_PET_URL),
    timeoutMs: integer(env.AT_PET_TIMEOUT_MS, 1500, 50, 2000),
    permissionWaitMs: integer(env.AT_PET_PERMISSION_WAIT_MS, 570000, 50, 570000),
    pollMs: 500,
    permissionMode,
  };
}

export function parsePayload(raw) {
  const payload = JSON.parse(raw.replace(/^\uFEFF/, '').trim() || '{}');
  if (!object(payload)) throw new Error('Hook payload must be a JSON object');
  return payload;
}

export function readPayload(stream = process.stdin, timeoutMs = 1200) {
  if (stream.isTTY) return Promise.resolve({});
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    const finish = (error, payload) => {
      clearTimeout(timer);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onError);
      stream.pause();
      error ? reject(error) : resolve(payload);
    };
    const onData = chunk => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_INPUT_BYTES) finish(new Error('Hook payload exceeds 1 MiB'));
      else chunks.push(buffer);
    };
    const onEnd = () => {
      try { finish(null, parsePayload(Buffer.concat(chunks).toString('utf8'))); }
      catch (error) { finish(error); }
    };
    const onError = error => finish(error);
    const timer = setTimeout(() => finish(new Error('Hook stdin timed out')), timeoutMs);
    stream.on('data', onData).once('end', onEnd).once('error', onError);
  });
}

export function sessionOf(payload) {
  const parent = text(payload.session_id || payload.sessionId);
  // Codex always supplies a session id. Skipping invalid input avoids mixing chats.
  if (!parent) return null;
  const child = text(payload.agent_id);
  if (!child) return { sessionId: parent, isSubagent: false, parentSessionId: '' };
  // At-Pet tracks child sessions separately by their actual Codex agent id.
  return { sessionId: child, isSubagent: true, parentSessionId: parent };
}

function toolFailed(response) {
  if (!object(response)) return false;
  return response.isError === true || response.success === false || response.status === 'failed' ||
    (Number.isInteger(response.exit_code) && response.exit_code !== 0) ||
    (Number.isInteger(response.exitCode) && response.exitCode !== 0);
}

export function buildEvent(payload) {
  const session = sessionOf(payload);
  if (!session) return null;
  const hook = payload.hook_event_name;
  let event = EVENTS.get(hook);
  if (hook === 'PostToolUse' && toolFailed(payload.tool_response)) event = 'error';
  if (hook === 'PostModelRequest') {
    event = payload.status === 'failed' ? 'error' : payload.status === 'cancelled' ? 'cancelled' : undefined;
  }
  // SessionStart must not remove a still-active session when Codex compacts/resumes.
  // A completed model request is not the end of a turn; Stop supplies that event.
  if (!event) return null;
  const body = { ...session, agentApp: AGENT_APP, event };
  const model = text(payload.model, 120);
  if (model) body.model = model;
  const tool = text(payload.tool_name || payload.toolName, 160);
  if (tool) { body.toolName = tool; body.message = tool; }
  return body;
}

export async function request(config, path, { method = 'GET', body, signal, timeoutMs } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs ?? config.timeoutMs)];
  if (signal) signals.push(signal);
  const response = await fetch(`${config.url}${path}`, {
    method, redirect: 'error', signal: AbortSignal.any(signals),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Read the body before the deadline, including servers that stall after headers.
  const raw = await response.text();
  if (!response.ok) throw new Error(`At-Pet HTTP ${response.status}`);
  return raw ? JSON.parse(raw) : {};
}

export function permissionResponse(behavior) {
  if (!['allow', 'deny'].includes(behavior)) return null;
  const decision = { behavior };
  if (behavior === 'deny') decision.message = 'Denied in At-Pet.';
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

export function permissionBody(payload) {
  const session = sessionOf(payload);
  const toolName = text(payload.tool_name || payload.toolName, 160);
  if (!session || !toolName) return null;
  const input = payload.tool_input;
  const detail = object(input)
    ? [input.description, input.command ?? input.cmd].filter(v => typeof v === 'string' && v).join('\n')
    : text(input, 2000);
  const description = detail || (input === undefined ? '' : JSON.stringify(input));
  return {
    ...session, agentApp: AGENT_APP, toolName,
    title: `Codex: ${toolName}`.slice(0, 160),
    description: description.length > 2000 ? description.slice(0, 1930) + '\n[已截断；完整工具参数请查看 Codex]' : description,
  };
}

export async function relayPermission(payload, config, signal) {
  const body = permissionBody(payload);
  if (!body) return null;
  let id = '';
  let consumed = false;
  const deadline = Date.now() + config.permissionWaitMs;
  const remaining = () => Math.max(1, Math.min(config.timeoutMs, deadline - Date.now()));
  try {
    const accepted = await request(config, '/permission', { method: 'POST', body, signal, timeoutMs: remaining() });
    id = text(accepted.requestId);
    if (!id) return null;
    while (Date.now() < deadline) {
      await delay(Math.min(config.pollMs, Math.max(1, deadline - Date.now())), undefined, { signal });
      if (Date.now() >= deadline) break;
      const result = await request(config, `/permission/${encodeURIComponent(id)}`, { signal, timeoutMs: remaining() });
      const behavior = result.status === 'allowed_once' ? 'allow' : result.status === 'denied' ? 'deny' : null;
      if (behavior) { consumed = true; return permissionResponse(behavior); }
      if (result.status !== 'pending') break;
    }
  } catch {
    // Silence delegates to Codex's ordinary approval prompt; never infer consent.
  } finally {
    if (id && !consumed) {
      await request(config, `/permission/${encodeURIComponent(id)}`, { method: 'DELETE', timeoutMs: 500 }).catch(() => {});
    }
  }
  return null;
}

export async function handlePayload(payload, config = settings(), signal) {
  if (payload.hook_event_name === 'PermissionRequest' && config.permissionMode === 'relay') {
    return relayPermission(payload, config, signal);
  }
  const event = buildEvent(payload);
  if (event) await request(config, '/event', { method: 'POST', body: event, signal });
  return null;
}

export async function main() {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  try {
    const payload = await readPayload();
    const config = settings();
    const output = await handlePayload(payload, config, controller.signal);
    if (output) process.stdout.write(JSON.stringify(output));
  } catch (error) {
    if (process.env.AT_PET_DEBUG === '1') process.stderr.write(`codex-at-pet: ${error.message}\n`);
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    // All hook failures are advisory. Only explicit permission responses steer Codex.
    process.exitCode = 0;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
