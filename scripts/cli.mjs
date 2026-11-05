import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { buildEvent, readPayload, request, settings } from './bridge.mjs';

try {
  const action = process.argv[2];
  if (action === 'preview') {
    console.log(JSON.stringify(buildEvent(await readPayload()), null, 2));
  } else if (action === 'doctor') {
    const config = settings();
    console.log(`Node.js ${process.version}; At-Pet ${config.url}; permission mode: ${config.permissionMode}`);
    const health = await request(config, '/health');
    if (health.ok !== true) throw new Error('Health endpoint did not return {"ok":true}');
    console.log('At-Pet is reachable. After installing the plugin, review its hooks in Codex.');
  } else if (action === 'demo') {
    const config = settings();
    const sessionId = `codex-at-pet-demo-${randomUUID()}`;
    try {
      for (const event of ['thinking', 'tool_start', 'tool_end', 'done']) {
        await request(config, '/event', { method: 'POST', body: { sessionId, agentApp: 'openai-codex', event, message: 'At-Pet connection demo' } });
        console.log(event);
        await delay(700);
      }
    } finally {
      await request(config, '/event', { method: 'POST', body: { sessionId, agentApp: 'openai-codex', event: 'session_end' } }).catch(() => {});
    }
  } else {
    throw new Error('Usage: node scripts/cli.mjs doctor | demo | preview (JSON on stdin)');
  }
} catch (error) {
  console.error(`codex-at-pet: ${error.message}`);
  process.exitCode = 1;
}
