// Lists the models each account offers (no message sent).
import { query } from '@anthropic-ai/claude-agent-sdk';
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
const DATA = process.env.HYDRA_DATA || (() => { const n = path.join(os.homedir(), '.hydra'), old = path.join(os.homedir(), '.multiclaude'); return !fs.existsSync(n) && fs.existsSync(old) ? old : n; })();
for (const id of ['account-1', 'account-2', 'account-3']) {
  let release; const idle = (async function* () { await new Promise(r => (release = r)); })();
  const q = query({ prompt: idle, options: { cwd: DATA, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(DATA, id) }, settingSources: [] } });
  try {
    const ms = await q.supportedModels();
    console.log(id); for (const m of ms) console.log('  ', m.value, '|', m.displayName, '|', m.resolvedModel || '');
  } catch (e) { console.log(id, 'error', e.message); }
  finally { release?.(); q.close(); }
}
