// Probe: does a note-based handoff pick up sensibly?
// Session A starts a small multi-step task in a throwaway git repo and is cut
// off abruptly partway through. Session B (fresh, no shared conversation) gets
// only HANDOFF.md + git status/diff + the unanswered message, and must finish.
// Usage: node probes/handoff-probe.mjs <scratch-dir> <config-dir>
import { query } from '@anthropic-ai/claude-agent-sdk';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sessionRules, handoffBrief, HANDOFF_FILE } from '../prompts.mjs';

const [dir, configDir] = process.argv.slice(2);
const git = (...a) => { try { return execFileSync('git', a, { cwd: dir, encoding: 'utf8' }); } catch (e) { return e.stdout || ''; } };

fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'convert.js'), '// unit conversions\nmodule.exports = {};\n');
fs.writeFileSync(path.join(dir, 'test.js'), "const c = require('./convert');\nconsole.log('all tests passed');\n");
git('init', '-q'); git('add', '-A'); git('-c', 'user.name=probe', '-c', 'user.email=probe@local', 'commit', '-qm', 'start');

const TASK = 'In convert.js add and export four functions, one at a time: cToF, fToC, kmToMiles, milesToKm. After each one, add an assert-based test for it in test.js, run `node test.js`, and commit. Keep HANDOFF.md current as you go.';

const opts = (extra) => ({
  cwd: dir, model: 'sonnet', settingSources: [],
  env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, GIT_AUTHOR_NAME: 'probe', GIT_AUTHOR_EMAIL: 'probe@local', GIT_COMMITTER_NAME: 'probe', GIT_COMMITTER_EMAIL: 'probe@local' },
  systemPrompt: { type: 'preset', preset: 'claude_code', append: sessionRules() },
  canUseTool: async (_t, input) => ({ behavior: 'allow', updatedInput: input }),
  ...extra,
});

function log(tag, m) {
  if (m.type === 'assistant') for (const c of m.message.content) {
    if (c.type === 'text') console.log(`[${tag}] says: ${c.text.slice(0, 300)}`);
    if (c.type === 'tool_use') console.log(`[${tag}] tool: ${c.name} ${JSON.stringify(c.input).slice(0, 120)}`);
  }
  if (m.type === 'result') console.log(`[${tag}] result: ${m.subtype} error=${m.is_error}`);
}

// ---- Session A: cut off after its second commit plus two more tool calls.
console.log('=== Session A ===');
const qa = query({ prompt: TASK, options: opts({}) });
let commitsSeen = 0, after = 0, cut = false;
try {
  for await (const m of qa) {
    log('A', m);
    if (m.type === 'assistant') for (const c of m.message.content) if (c.type === 'tool_use') {
      if (commitsSeen >= 2) after++;
      if (c.name === 'Bash' && /git commit/.test(c.input.command || '')) commitsSeen++;
    }
    if (after >= 2) { cut = true; console.log('[A] *** CUT OFF ***'); qa.close(); break; }
  }
} catch (e) { console.log('[A] ended:', e.message); }
console.log('Session A was cut off:', cut);
console.log('git log after A:\n' + git('log', '--oneline'));

// ---- Session B: fresh conversation from the note only.
const notePath = path.join(dir, HANDOFF_FILE);
const brief = handoffBrief({
  projectName: 'probe-project', reason: 'its account ran out of usage',
  note: fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : '',
  status: git('status', '--short').trim(), diff: git('diff', 'HEAD'), lastMessage: TASK,
});
console.log('\n=== Session B (brief is ' + brief.length + ' chars) ===');
try { for await (const m of query({ prompt: brief, options: opts({}) })) log('B', m); }
catch (e) { console.log('[B] ended:', e.message); }

console.log('\n=== Final state ===');
console.log(git('log', '--oneline'));
console.log(git('status', '--short') || '(clean)');
try { console.log(execFileSync('node', ['test.js'], { cwd: dir, encoding: 'utf8' })); } catch (e) { console.log('TESTS FAILED', e.stdout, e.stderr); }
console.log('--- HANDOFF.md ---\n' + (fs.existsSync(notePath) ? fs.readFileSync(notePath, 'utf8') : '(missing)'));
console.log('--- convert.js ---\n' + fs.readFileSync(path.join(dir, 'convert.js'), 'utf8'));
