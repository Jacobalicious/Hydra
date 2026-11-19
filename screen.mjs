// Lets a chat see and use the user's screen: screenshot, click, type, keys.
// The Claude desktop app has this built in, but Hydra's chats run through
// the Agent SDK and do not get it, so this is our own small version.
// The real work is done by screen.ps1, kept running and fed one JSON line at a time.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { NAME } from './me.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screen.ps1');
export const SCREEN_PREFIX = 'mcp__screen__';

let ps = null, buf = '', waiting = [], chain = Promise.resolve();

function helper() {
  if (ps) return ps;
  const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;   // PowerShell chatter, not an answer
      const w = waiting.shift();
      if (!w) continue;
      try { w.resolve(JSON.parse(line)); } catch (e) { w.reject(e); }
    }
  });
  p.stderr.setEncoding('utf8');
  p.stderr.on('data', d => console.error('[screen]', d.trim()));
  const gone = () => {
    if (ps !== p) return;
    ps = null; buf = '';
    for (const w of waiting.splice(0)) w.reject(new Error('The screen helper stopped. Try again.'));
  };
  p.on('exit', gone); p.on('error', gone);
  return (ps = p);
}

// One command at a time across every chat: two chats must not drive the mouse at once.
function run(cmd, timeoutMs = 30000) {
  const job = chain.then(() => new Promise((resolve, reject) => {
    const p = helper();
    const t = setTimeout(() => { reject(new Error('The screen helper did not answer in time.')); p.kill(); }, timeoutMs);
    waiting.push({ resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
    // Non-ASCII as \u escapes, so the text survives whatever encoding PowerShell's stdin uses.
    p.stdin.write(JSON.stringify(cmd).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) + '\n');
  }));
  chain = job.catch(() => {});
  return job.then(r => { if (!r.ok) throw new Error(r.error || 'failed'); return r; });
}

export function stopScreenHelper() { if (ps) { ps.stdin.end(); ps = null; } }

const text = s => ({ content: [{ type: 'text', text: s }] });
const fail = e => ({ content: [{ type: 'text', text: 'Did not work: ' + (e.message || e) }], isError: true });
const wrap = fn => async args => { try { return await fn(args); } catch (e) { return fail(e); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function shot(screen) {
  const r = await run({ op: 'screenshot', screen: screen ? screen - 1 : undefined });
  return { content: [
    { type: 'image', data: r.data, mimeType: 'image/jpeg' },
    { type: 'text', text: `Screen ${r.screen} of ${r.screens} (${r.realWidth}x${r.realHeight}), shown at ${r.width}x${r.height}. Give x/y for clicks in this image's pixels; they apply to this screen until you screenshot another.` },
  ] };
}
// Actions can hand back a fresh screenshot so Claude sees the result in the same step.
const after = async (args, msg) => args.screenshot_after ? shot() : text(msg);

const XY = { x: z.number().describe('x in the last screenshot'), y: z.number().describe('y in the last screenshot') };
const SA = { screenshot_after: z.boolean().optional().describe('Take a screenshot right after (waits 0.5s first)') };
const settle = async args => { if (args.screenshot_after) await sleep(500); };

// One action, shared by batch.
async function act(a) {
  switch (a.action) {
    case 'click': return run({ op: 'click', x: a.x, y: a.y, button: a.button, count: a.count, hold: a.hold });
    case 'move_mouse': return run({ op: 'move', x: a.x, y: a.y, relative: a.relative, dx: a.dx, dy: a.dy });
    case 'drag': return run({ op: 'drag', x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, button: a.button });
    case 'scroll': return run({ op: 'scroll', amount: a.amount || 3, direction: a.direction, x: a.x, y: a.y });
    case 'type': return run({ op: 'type', text: a.text }, 120000);
    case 'key': return run({ op: 'key', keys: a.keys, repeat: a.repeat });
    case 'hold_key': return run({ op: 'hold', keys: a.keys, seconds: a.seconds }, a.seconds * 1000 + 30000);
    case 'wait': return sleep(Math.min(60, a.seconds || 1) * 1000);
    default: throw new Error(`Unknown action "${a.action}"`);
  }
}

// What the main chat may use itself; everything else on the screen goes through the helper.
export const LOOK_TOOLS = ['screenshot', 'zoom', 'windows'].map(t => SCREEN_PREFIX + t);
export const ALL_SCREEN_TOOLS = ['screenshot', 'zoom', 'windows', 'batch', 'click', 'move_mouse', 'drag', 'scroll', 'type', 'key', 'hold_key', 'focus_window', 'wait'].map(t => SCREEN_PREFIX + t);

// The helper: a cheaper model with its own short memory does the clicking, so
// dozens of screenshots never pile up in the main chat (which re-reads all of
// them on every later step).
export const SCREEN_AGENT = {
  description: "Does things on " + NAME + "'s screen (computer use): clicking through an app, changing settings, filling in values, reading numbers off the screen. Give it ONE clear task: which app/window, what to do, what done looks like, and what to read back. Keep each task to one part of the job (it stops after 60 steps). It reports in text what it did and what it saw. Use it for every screen action; it is far cheaper than clicking yourself.",
  prompt: `You are the hands for another Claude chat, working on ${NAME}'s real Windows screen with the mcp__screen__* tools.
Do the one task you were given, then reply with a short report: what you did, what is on screen now, any values you were asked to read (exactly as shown), and anything that went wrong.

Be economical. Every screenshot you take is re-read on each of your later steps.
- Start with one screenshot. After that, prefer actions with screenshot_after, or batch (several steps, one screenshot at the end) when you know where things are, e.g. click a field, select all, type a value, press enter.
- To read small text or numbers, use zoom on that box instead of guessing or taking more full screenshots. Zoomed pictures are for reading only: click using full-screenshot coordinates.
- Use wait (with its screenshot) only when something is actually loading.
Stop and report instead of pushing on when: a sign-in or password box appears (never type passwords or codes; ${NAME} does that), something unexpected pops up, ${NAME} seems to be using the mouse, or the same step fails three times.`,
  tools: ALL_SCREEN_TOOLS,
  model: 'sonnet',
  effort: 'low',
  omitClaudeMd: true,
  maxTurns: 60,   // a runaway helper stops and reports; split big jobs into parts
};

// PreToolUse hook: on the main chat, only looking is allowed; doing goes to the helper.
export function screenHook() {
  return [{ matcher: 'mcp__screen__.*', hooks: [async input => {
    if (input.agent_id || LOOK_TOOLS.includes(input.tool_name)) return {};
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny',
      permissionDecisionReason: 'In this chat you can only look at the screen (screenshot, zoom, windows). To click, type or press keys, send the screen helper: the Agent tool with subagent_type "screen" and one clear task. It is much cheaper.' } };
  }] }, {
    // Helpers run in the foreground: a reply only counts as done (the "Claude is
    // done" ping, account switches, fresh chats) once its helpers have reported.
    matcher: 'Agent|Task', hooks: [async input => {
      if (input.agent_id || !input.tool_input || input.tool_input.run_in_background === false) return {};
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input.tool_input, run_in_background: false } } };
    }],
  }];
}

// A fresh server per chat: one server object cannot be shared by two conversations.
export function makeScreenServer() {
  return createSdkMcpServer({
    name: 'screen',
    version: '1.0.0',
    instructions: "These tools are computer use: they see and control " + NAME + "'s real Windows screen. Start with screenshot. Check results with screenshot_after or batch, and read small text with zoom. " + NAME + " is usually watching; if they move the mouse or something unexpected pops up, stop and ask.",
    tools: [
      tool('screenshot', "See " + NAME + "'s screen. Do this first, and again whenever you need to see what changed.",
        { screen: z.number().int().min(1).optional().describe('Which monitor, 1 = first. Default: the one last looked at, else the main one.') },
        wrap(a => shot(a.screen)), { annotations: { readOnlyHint: true }, searchHint: 'computer use screen control desktop mouse keyboard click screenshot', alwaysLoad: true }),
      tool('zoom', 'See a box of the last screenshot at full resolution, to read small text or numbers. For reading only: click with full-screenshot coordinates.',
        { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() },
        wrap(async a => {
          const r = await run({ op: 'zoom', ...a });
          return { content: [{ type: 'image', data: r.data, mimeType: 'image/jpeg' }, { type: 'text', text: `Zoomed (${r.width}x${r.height}). Reading only; clicks still use the last full screenshot's coordinates.` }] };
        }), { annotations: { readOnlyHint: true } }),
      tool('batch', 'Do several actions in a row, then take ONE screenshot (unless screenshot=false). Much cheaper than one tool call per step when you already know where things are. Stops at the first action that fails.',
        { actions: z.array(z.object({
            action: z.enum(['click', 'move_mouse', 'drag', 'scroll', 'type', 'key', 'hold_key', 'wait']),
            x: z.number().optional(), y: z.number().optional(), button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional(), hold: z.array(z.string()).optional(),
            relative: z.boolean().optional(), dx: z.number().optional(), dy: z.number().optional(),
            x1: z.number().optional(), y1: z.number().optional(), x2: z.number().optional(), y2: z.number().optional(),
            direction: z.enum(['up', 'down', 'left', 'right']).optional(), amount: z.number().int().min(1).max(30).optional(),
            text: z.string().optional(), keys: z.string().optional(), repeat: z.number().int().min(1).max(50).optional(), seconds: z.number().min(0.05).max(60).optional(),
          })).min(1).max(30).describe('In order. click: x,y (button, count, hold). type: text. key: keys (repeat). scroll: direction (amount, x, y). drag: x1,y1,x2,y2. move_mouse: x,y or relative+dx,dy. hold_key: keys, seconds. wait: seconds.'),
          pause: z.number().min(0).max(5).optional().describe('Seconds between actions, default 0.15'),
          screenshot: z.boolean().optional().describe('Default true') },
        wrap(async a => {
          let done = 0;
          for (const step of a.actions) {
            try { await act(step); } catch (e) { return fail(new Error(`step ${done + 1} (${step.action}): ${e.message || e}. ${done} step(s) done before it.`)); }
            done++;
            await sleep((a.pause ?? 0.15) * 1000);
          }
          if (a.screenshot === false) return text(`Done ${done} step(s).`);
          await sleep(400);
          return shot();
        })),
      tool('click', 'Click at a point in the last screenshot.',
        { ...XY, button: z.enum(['left', 'right', 'middle']).optional(), count: z.number().int().min(1).max(3).optional().describe('2 = double-click'),
          hold: z.array(z.string()).optional().describe('Keys held during the click, e.g. ["shift"]'), ...SA },
        wrap(async a => { await run({ op: 'click', ...a }); await settle(a); return after(a, 'Clicked.'); })),
      tool('move_mouse', 'Move the mouse to a point in the last screenshot, or by dx/dy real pixels with relative=true (that is how you turn the camera in a game like Minecraft).',
        { x: z.number().optional(), y: z.number().optional(), relative: z.boolean().optional(), dx: z.number().optional(), dy: z.number().optional(), ...SA },
        wrap(async a => { await run({ op: 'move', ...a }); await settle(a); return after(a, 'Moved.'); })),
      tool('drag', 'Press at one point and release at another (both in the last screenshot).',
        { x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number(), button: z.enum(['left', 'right', 'middle']).optional(), ...SA },
        wrap(async a => { await run({ op: 'drag', ...a }); await settle(a); return after(a, 'Dragged.'); })),
      tool('scroll', 'Scroll the mouse wheel, optionally at a point first.',
        { direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(30).optional().describe('Wheel clicks, default 3'), x: z.number().optional(), y: z.number().optional(), ...SA },
        wrap(async a => { await run({ op: 'scroll', amount: 3, ...a }); await settle(a); return after(a, 'Scrolled.'); })),
      tool('type', 'Type text into whatever has focus. Text only: games do not see this as key presses, so use key to open a game\'s chat (e.g. "t" or "/" in Minecraft) and then type.',
        { text: z.string(), ...SA },
        wrap(async a => { await run({ op: 'type', text: a.text }, 120000); await settle(a); return after(a, 'Typed.'); })),
      tool('key', 'Press a key or shortcut: "enter", "esc", "ctrl+s", "alt+tab", "f3", "w", "/". Real key presses, so games see them.',
        { keys: z.string(), repeat: z.number().int().min(1).max(50).optional(), ...SA },
        wrap(async a => { await run({ op: 'key', keys: a.keys, repeat: a.repeat }); await settle(a); return after(a, 'Pressed.'); })),
      tool('hold_key', 'Hold keys (and/or mouseleft / mouseright) down for some seconds, e.g. "w" to walk forward, "ctrl+w" to sprint, "mouseleft" to break a block.',
        { keys: z.string(), seconds: z.number().min(0.05).max(30), ...SA },
        wrap(async a => { await run({ op: 'hold', keys: a.keys, seconds: a.seconds }, a.seconds * 1000 + 30000); await settle(a); return after(a, 'Held and released.'); })),
      tool('windows', 'List the open windows (title, position, which one is in front).', {},
        wrap(async () => {
          const r = await run({ op: 'windows' });
          return text((r.windows || []).map(w => `${w.id}  ${w.active ? '[in front] ' : ''}${w.minimized ? '[minimized] ' : ''}${w.title}  (${w.w}x${w.h} at ${w.x},${w.y})`).join('\n') || 'No windows.');
        }), { annotations: { readOnlyHint: true } }),
      tool('focus_window', 'Bring a window to the front, by part of its title (from windows).',
        { title: z.string(), ...SA },
        wrap(async a => {
          const r = await run({ op: 'windows' });
          const want = a.title.toLowerCase();
          const w = (r.windows || []).find(w => w.title.toLowerCase() === want) || (r.windows || []).find(w => w.title.toLowerCase().includes(want));
          if (!w) return fail(new Error(`No window title contains "${a.title}".`));
          await run({ op: 'focus', id: w.id }); await sleep(300);
          return a.screenshot_after ? shot() : text(`Brought "${w.title}" to the front.`);
        })),
      tool('wait', 'Wait a few seconds (for something to load), then take a screenshot.',
        { seconds: z.number().min(0.1).max(60), screenshot: z.boolean().optional().describe('Default true') },
        wrap(async a => { await sleep(a.seconds * 1000); return a.screenshot === false ? text('Waited.') : shot(); }), { annotations: { readOnlyHint: true } }),
    ],
  });
}
