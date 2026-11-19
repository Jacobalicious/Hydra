// Probe: for each config dir given on the command line, open an SDK session
// WITHOUT sending a prompt, then read account info and plan usage. Spends nothing.
import { query } from '@anthropic-ai/claude-agent-sdk';

async function probe(dir) {
  let release;
  const idle = (async function* () { await new Promise(r => (release = r)); })();
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  const q = query({ prompt: idle, options: { cwd: process.cwd(), env, permissionMode: 'default', settingSources: [] } });
  try {
    const acct = await q.accountInfo();
    const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    console.log(JSON.stringify({ dir, email: acct.email, sub: usage.subscription_type, available: usage.rate_limits_available, limits: usage.rate_limits }, null, 1));
  } catch (e) {
    console.log(dir, 'ERROR', e.message);
  } finally {
    release(); q.close();
  }
}
for (const d of process.argv.slice(2)) await probe(d);
