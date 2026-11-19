// Pick a model while Claude is mid-reply, then stop it, then send again: which model answers?
import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os'; import path from 'node:path';
const DATA = process.env.MULTICLAUDE_DATA || path.join(os.homedir(), '.multiclaude');
const [id = 'account-2', model = 'fable', stop = 'stop'] = process.argv.slice(2);
let push; const queue = [];
const iter = (async function* () { while (true) { if (queue.length) yield queue.shift(); else await new Promise(r => (push = r)); } })();
const say = t => { queue.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); push?.(); };
const q = query({ prompt: iter, options: { cwd: DATA, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(DATA, id) }, settingSources: [], tools: [], persistSession: false, permissionMode: 'default', includePartialMessages: true } });
say('Count from 1 to 60, one number per line.');
let turn = 0, switched = false;
for await (const m of q) {
  if (m.type === 'stream_event' && !switched && turn === 0) {
    switched = true;
    try { await q.setModel(model); console.log('setModel while busy ok'); } catch (e) { console.log('setModel threw:', e.message); }
    if (stop === 'stop') { await q.interrupt(); console.log('interrupted'); }
  }
  if (m.type === 'assistant') console.log('turn', turn, 'answered by', m.message.model);
  if (m.type === 'result') {
    turn++;
    if (turn === 1) say('Reply with just the word hi.'); else { q.close(); break; }
  }
}
