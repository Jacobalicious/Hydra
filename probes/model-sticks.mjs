// Does a picked model actually answer? Start on one model, then switch mid-chat with setModel.
// Usage: node probes/model-sticks.mjs account-2 "claude-fable-5-1[1m]"
import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os'; import path from 'node:path';
const DATA = process.env.MULTICLAUDE_DATA || path.join(os.homedir(), '.multiclaude');
const [id = 'account-2', model = 'claude-fable-5-1[1m]'] = process.argv.slice(2);
let push; const queue = [];
const iter = (async function* () { while (true) { if (queue.length) yield queue.shift(); else await new Promise(r => (push = r)); } })();
const say = t => { queue.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); push?.(); };
const q = query({ prompt: iter, options: { cwd: DATA, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(DATA, id) }, settingSources: [], tools: [], persistSession: false, permissionMode: 'default' } });
say('Reply with just the word hi.');
let turn = 0;
for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') console.log('init model:', m.model);
  if (m.type === 'system' && m.subtype !== 'init') console.log('system:', m.subtype, JSON.stringify(m).slice(0, 200));
  if (m.type === 'assistant') console.log('turn', turn, 'answered by', m.message.model);
  if (m.type === 'result') {
    turn++;
    if (turn === 1) { try { await q.setModel(model); console.log('setModel ok ->', model); } catch (e) { console.log('setModel threw:', e.message); } say('Reply with just the word hi.'); }
    else { q.close(); break; }
  }
}
