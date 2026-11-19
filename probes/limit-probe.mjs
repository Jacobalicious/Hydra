// Probe: send a one-word prompt on a profile and print every message type,
// to see exactly what "this account is out" looks like in structured output.
import { query } from '@anthropic-ai/claude-agent-sdk';
const dir = process.argv[2];
const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
const q = query({ prompt: 'Reply with the single word: ok', options: { cwd: process.cwd(), env, tools: [], settingSources: [], maxTurns: 1 } });
for await (const m of q) {
  const brief = { type: m.type, subtype: m.subtype };
  if (m.type === 'rate_limit_event') brief.info = m.rate_limit_info;
  if (m.type === 'assistant') { brief.error = m.error; brief.text = m.message?.content?.map(c => c.text).join(''); }
  if (m.type === 'result') Object.assign(brief, { is_error: m.is_error, result: m.result, errors: m.errors, stop: m.stop_reason, api_error_status: m.api_error_status });
  if (m.type === 'system' && m.subtype === 'api_retry') brief.retry = m;
  console.log(JSON.stringify(brief));
}
