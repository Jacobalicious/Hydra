// Hydra: one page to chat with Claude Code about any folder, moving
// between several Claude accounts when one runs out.
// Listens on 127.0.0.1 only. The phone reaches it through `tailscale serve`,
// which forwards https://<pc>.<tailnet>.ts.net to this port, so nothing else on
// any network can. Never calls process.exit().
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { makeScreenServer, SCREEN_PREFIX, SCREEN_AGENT, screenHook } from './screen.mjs';
import { makePush } from './push.mjs';
import { NAME, PROJECTS_ROOT, DATA_DIR } from './me.mjs';
import { sessionRules, handoffBrief, quickHandoffBrief, newProjectBrief, workerBrief, workerReport, WRITE_NOTE_NOW, HANDOFF_FILE } from './prompts.mjs';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const PORT = Number(process.env.HYDRA_PORT || 4517);
const HOST = '127.0.0.1';
const CHATS_DIR = path.join(DATA_DIR, 'chats');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const QUICK_DIR = path.join(DATA_DIR, 'quick');   // one empty scratch folder per quick chat
const WORKERS_DIR = path.join(DATA_DIR, 'workers');   // one git worktree per worker (a lead chat's helper with its own copy)
const MAX_WORKERS = 3;   // open workers per lead
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOG_FILE = path.join(DATA_DIR, 'switch-log.txt');
// The token-diet mod (plugins/token-diet), loaded into every chat. Must be a plain
// Windows path: a %20-style path silently loads nothing.
const DIET_DIR = process.env.HYDRA_DIET || path.join(HERE, 'plugins', 'token-diet');
const plugins = () => fs.existsSync(path.join(DIET_DIR, '.claude-plugin', 'plugin.json')) ? [{ type: 'local', path: DIET_DIR }] : [];
const DEFAULT_CONFIG_DIR = path.join(HOME, '.claude');
const GLOBAL_CLAUDE_MD = path.join(DEFAULT_CONFIG_DIR, 'CLAUDE.md');
const NEAR_FIVE = 95;   // % of the 5-hour limit at which we hand off between turns
const NEAR_WEEK = 98;   // % of the weekly limit at which we hand off between turns
const REFRESH_EVERY = 10 * 60 * 1000;
const MAX_UPLOAD = 30 * 1024 * 1024;
const MODES = ['default', 'acceptEdits', 'plan', 'auto'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

fs.mkdirSync(CHATS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const push = makePush(path.join(DATA_DIR, 'push.json'));   // phones that asked for alerts

// ---------------------------------------------------------------- storage
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 2));

// Each account gets its own folder that nothing else uses. Do not point one
// at ~\.claude: that folder's login changes whenever the user
// switches accounts by hand in their normal Claude Code.
function defaultAccounts() {
  return [1, 2, 3].map(n => ({ id: `account-${n}`, configDir: path.join(DATA_DIR, `account-${n}`) }));
}
if (!fs.existsSync(ACCOUNTS_FILE)) writeJson(ACCOUNTS_FILE, defaultAccounts());
let accountList = readJson(ACCOUNTS_FILE, null);
if (!Array.isArray(accountList) || !accountList.length) {
  console.error(`Could not read ${ACCOUNTS_FILE} (a typo? backslashes must be doubled). Using the default three account folders for now.`);
  accountList = defaultAccounts();
}

const saved = readJson(STATE_FILE, {});
const state = {
  mode: MODES.includes(saved.mode) ? saved.mode : 'acceptEdits',   // permission mode for new sessions
  model: saved.model || null,                 // null = Claude Code's default
  effort: saved.effort || null,               // null = the model's default
  folders: saved.folders || [],               // folders the user added by hand, outside the scan
  pinned: saved.pinned || [],                 // his main projects, shown at the top of the sidebar
  unstarred: saved.unstarred || [],           // projects he unstarred by hand: never auto-starred again
  quickOrder: saved.quickOrder || [],         // quick chats in the order he dragged them to (others go on top, newest first)
  models: saved.models || [],                 // what the accounts offer (from supportedModels)
  commands: saved.commands || [],             // slash commands (from supportedCommands)
  projects: saved.projects || {},             // projectPath -> { accountId, sessionId }
  workers: saved.workers || {},               // worktreePath -> { lead, name, branch, task, startedAt }
  accounts: accountList.map(a => ({
    ...a, label: a.label || a.id, email: null, signedIn: false,
    five: null, week: null, outUntil: null, outKind: null, checkedAt: null, error: null, modelOut: {},
    ...(saved.usage?.[a.id] || {}),
  })),
};
// An old "out for the week" from the server while the week was far from used
// was really one model's own weekly limit (it locked account-2 for days while
// it was at 11%). Drop it; that model relearns its limit on its next try.
for (const a of state.accounts) {
  a.modelOut ||= {};
  if (a.outSource === 'rejected' && a.outKind === 'weekly' && (a.week?.util ?? 0) < 100) { a.outUntil = null; a.outKind = null; a.outSource = null; }
}
// Projects whose work is parked because every account is out: project -> { lastMessage, since, fromAccount }
const waits = new Map();
// Projects where Claude finished a reply the user has not looked at yet (the blue dot in the sidebar).
const unseen = new Set();
const pinIt = p => { state.pinned = state.pinned.filter(x => !sameDir(x, p)); state.pinned.push(p); persist(); };
for (const a of state.accounts) fs.mkdirSync(a.configDir, { recursive: true });
function persist() {
  const usage = {};
  for (const a of state.accounts) usage[a.id] = { email: a.email, signedIn: a.signedIn, loginDead: a.loginDead || null, five: a.five, week: a.week, outUntil: a.outUntil, outKind: a.outKind, outSource: a.outSource, modelOut: a.modelOut, checkedAt: a.checkedAt };
  const { mode, model, effort, folders, pinned, unstarred, quickOrder, models, commands, projects, workers } = state;
  writeJson(STATE_FILE, { mode, model, effort, folders, pinned, unstarred, quickOrder, models, commands, projects, workers, usage });
}

// ---------------------------------------------------------------- events to the page
const clients = new Set();
function send(ev) { const s = `data: ${JSON.stringify(ev)}\n\n`; for (const c of clients) c.write(s); }
function pushState() { send({ type: 'state', state: publicState() }); syncDot(); }

// ---------------------------------------------------------------- taskbar status dot
// The "claude check" tray dot reads one file per chat from ~/.claude/status-dot.
// Its hooks live in ~/.claude/settings.json, which these chats never load (each
// account has its own config folder), so report each chat's state here instead.
// One file per project, so a handoff to another account reuses it. Files are
// only written when a state changes, so a chat dismissed from the dot stays
// dismissed until it does something new. A finished chat that gets closed for
// being idle stays green; one that stops mid-work is removed.
const DOT_DIR = path.join(HOME, '.claude', 'status-dot');
const dotSeen = new Map();   // project -> last state written
const dotFile = project => path.join(DOT_DIR, `multiclaude-${crypto.createHash('sha1').update(project.toLowerCase()).digest('hex').slice(0, 12)}.json`);
function syncDot() {
  try {
    const live = new Set();
    for (const r of runs.values()) {
      live.add(r.project);
      const s = r.perms.size ? 'waiting' : r.busy ? 'working' : 'done';
      if (dotSeen.get(r.project) === s) continue;
      dotSeen.set(r.project, s);
      fs.mkdirSync(DOT_DIR, { recursive: true });
      fs.writeFileSync(dotFile(r.project), JSON.stringify({ state: s, project: projectName(r.project), updated: Date.now(), by: 'multiclaude' }));
    }
    for (const [project, s] of dotSeen) {
      if (live.has(project)) continue;
      dotSeen.delete(project);
      if (s !== 'done') fs.rmSync(dotFile(project), { force: true });
    }
  } catch {}
}
// He wrote back, or took the project off his main list: clear its dot now.
// dotSeen keeps its value, so a live chat is not rewritten until its state changes.
function dotDismiss(project) { try { fs.rmSync(dotFile(project), { force: true }); } catch {} }
// Anything still "working" or "needs you" from before Hydra last closed is not running any more.
try {
  for (const f of fs.readdirSync(DOT_DIR)) {
    if (!f.startsWith('hydra-')) continue;
    try { if (JSON.parse(fs.readFileSync(path.join(DOT_DIR, f), 'utf8')).state !== 'done') fs.rmSync(path.join(DOT_DIR, f), { force: true }); } catch {}
  }
} catch {}
// Long turns: refresh "working" so the dot doesn't take them for crashed after 2h.
setInterval(() => {
  for (const [project, s] of dotSeen) if (s === 'working') dotSeen.delete(project);
  syncDot();
}, 30 * 60 * 1000);
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);   // keeps phone connections open

// ---------------------------------------------------------------- windows notifications
function notify(title, body, project = null) {
  const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$x = $t.GetElementsByTagName('text')
$x.Item(0).AppendChild($t.CreateTextNode($env:MC_TITLE)) > $null
$x.Item(1).AppendChild($t.CreateTextNode($env:MC_BODY)) > $null
$id = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($id).Show([Windows.UI.Notifications.ToastNotification]::new($t))`;
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      env: { ...process.env, MC_TITLE: 'Hydra: ' + title, MC_BODY: body }, stdio: 'ignore', windowsHide: true,
    });
    p.on('error', () => {});
  } catch { /* notifications are best-effort */ }
  send({ type: 'notify', title, body, project });   // an open page shows its own
  push.send({ title, body, project }).catch(() => {});   // phones, even with the page closed
}

// ---------------------------------------------------------------- Run button
// The page's Run button on shell code blocks: runs the block in Windows
// PowerShell 5.1 (what the user's own terminal is) in the project folder and
// hands back what it printed. Programs it starts with Start-Process still open
// their own windows; prompts can't be answered, so they fail fast instead.
const RUN_TIMEOUT = 10 * 60 * 1000, RUN_MAX_OUT = 200 * 1024;
// "Terminal" button: opens a real PowerShell window on the PC, in the project
// folder, runs the block there and stays open, so live screens and prompts that
// need typing work.
function runInWindow(project, cmd) {
  const cwd = checkProject(project);
  cmd = String(cmd || '').trim();
  if (!cmd) throw new Error('That block is empty.');
  const dir = path.join(os.tmpdir(), 'hydra-run'); fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `run-${Date.now()}.ps1`);
  fs.writeFileSync(f, '﻿' + cmd + '\r\n', 'utf8');   // BOM so PowerShell 5.1 reads it as UTF-8
  const line = `/c start "Hydra" powershell.exe -NoExit -ExecutionPolicy Bypass -File "${f}"`;
  const p = spawn('cmd.exe', [line], { cwd, stdio: 'ignore', windowsHide: true, detached: true, windowsVerbatimArguments: true });
  p.on('error', () => {}); p.unref();
}
function runCommand(project, cmd) {
  const cwd = checkProject(project);
  cmd = String(cmd || '').trim();
  if (!cmd) throw new Error('That block is empty.');
  // One line of setup in front, so error messages' "At line:N" still match the block.
  const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ProgressPreference = 'SilentlyContinue'; ${cmd}`;
  const enc = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    let out = '', cut = false, timedOut = false;
    const add = c => { if (out.length < RUN_MAX_OUT) out += c; else cut = true; };
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', add); p.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; try { execFile('taskkill', ['/pid', String(p.pid), '/t', '/f'], () => {}); } catch {} }, RUN_TIMEOUT);
    p.on('error', e => { clearTimeout(timer); resolve({ code: -1, out: String(e.message || e) }); });
    p.on('close', code => {
      clearTimeout(timer);
      // PowerShell's error records come out as CLIXML noise when stderr is piped; keep just the words.
      out = out.replace(/#< CLIXML\r?\n?/g, '').replace(/<Objs[\s\S]*?<\/Objs>/g, m =>
        [...m.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)].map(x => x[1].replace(/_x000D__x000A_/g, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')).join(''));
      if (cut) out += '\n… (output cut off)';
      if (timedOut) out += '\n… (stopped after 10 minutes)';
      resolve({ code, out: out.trimEnd() });
    });
  });
}

// ---------------------------------------------------------------- switch log
function logSwitch(project, from, to, why) {
  const t = new Date();
  const stamp = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')} ${t.toTimeString().slice(0, 5)}`;
  const line = `${stamp} | ${projectName(project)} | ${from || '-'} -> ${to || '(none)'} | ${why}`;
  fs.appendFileSync(LOG_FILE, line + os.EOL);
  pushState();
}
function logTail(n = 40) {
  try { return fs.readFileSync(LOG_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-n).reverse(); } catch { return []; }
}

// ---------------------------------------------------------------- projects
let projectCache = null, placeCache = [];
const SKIP = new Set(['node_modules', '.git', '.vs', '.vscode', '.idea', '__pycache__']);
const sameDir = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
function scanProjects() {
  const out = [], places = [];
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const subdirs = entries.filter(e => e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'));
    const hasGit = entries.some(e => e.name === '.git');
    const hasFiles = entries.some(e => e.isFile() && !/^(desktop\.ini|thumbs\.db|\.ds_store)$/i.test(e.name));
    if (dir !== PROJECTS_ROOT) {
      const childHasGit = subdirs.some(s => fs.existsSync(path.join(dir, s.name, '.git')));
      if (hasGit || (hasFiles && !childHasGit)) { out.push(dir); return; }
      if (depth === 1 || (depth === 2 && !hasFiles)) places.push(dir);
    }
    if (depth < 3) for (const s of subdirs) walk(path.join(dir, s.name), depth + 1);
  };
  walk(PROJECTS_ROOT, 0);
  // A folder one level down only counts as a group when it holds a few projects
  // of its own (Games/Puzzle), not when it is one project in parts.
  const kids = d => out.filter(p => sameDir(path.dirname(p), d)).length;
  placeCache = places.filter(d => path.dirname(d) === PROJECTS_ROOT || kids(d) >= 3).map(p => path.relative(PROJECTS_ROOT, p)).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  for (const f of state.folders) if (fs.existsSync(f) && !out.some(x => sameDir(x, f))) out.push(f);
  out.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  return out;
}
function projects() { if (!projectCache) projectCache = scanProjects(); return projectCache; }
const insideRoot = p => { const r = path.relative(PROJECTS_ROOT, p); return r && !r.startsWith('..') && !path.isAbsolute(r); };
const isQuick = p => { if (!p) return false; const r = path.relative(QUICK_DIR, p); return !!r && !r.startsWith('..') && !path.isAbsolute(r) && !r.includes(path.sep); };
function quickChats() {
  try { return fs.readdirSync(QUICK_DIR, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => path.join(QUICK_DIR, e.name)); } catch { return []; }
}
function quickTitle(p) {
  const first = chat(p).find(i => i.kind === 'user' && i.text);
  return first ? String(first.text).replace(/\s+/g, ' ').trim().slice(0, 80) : 'New chat';
}
const workerOf = p => (p && state.workers[p]) || null;
const workerPaths = () => Object.keys(state.workers);
const projectName = p => (!p ? '' : workerOf(p) ? `${projectName(workerOf(p).lead)} › ${workerOf(p).name}` : isQuick(p) ? quickTitle(p) : insideRoot(p) ? path.relative(PROJECTS_ROOT, p) : p);
const known = p => projects().some(x => sameDir(x, p)) || quickChats().some(x => sameDir(x, p)) || workerPaths().some(x => sameDir(x, p));
function projectInfo(p) {
  let lastAt = null; try { lastAt = fs.statSync(chatFile(p)).mtimeMs; } catch {}
  const w = workerOf(p);
  if (w) return { path: p, name: projectName(p), worker: true, lead: w.lead, wname: w.name, branch: w.branch, task: w.task, git: true, note: false, added: false, lastAt };
  if (isQuick(p)) return { path: p, name: quickTitle(p), quick: true, git: false, note: false, added: false, lastAt, count: chat(p).filter(i => i.kind === 'user').length };
  return {
    path: p, name: projectName(p), git: fs.existsSync(path.join(p, '.git')), note: fs.existsSync(path.join(p, HANDOFF_FILE)),
    added: state.folders.some(f => sameDir(f, p)), lastAt,
  };
}
function checkProject(p) {
  const real = projects().find(x => x.toLowerCase() === String(p || '').toLowerCase()) || quickChats().find(x => x.toLowerCase() === String(p || '').toLowerCase())
    || workerPaths().find(x => x.toLowerCase() === String(p || '').toLowerCase());
  if (!real) throw new Error('That folder is not in the project list.');
  return real;
}

// The folder picker: browse any drive, add a folder, or make a new one.
function drives() {
  const out = [];
  for (const l of 'CDEFGHIJKLMNOPQRSTUVWXYZ') { const d = `${l}:\\`; try { fs.accessSync(d); out.push(d); } catch {} }
  return out;
}
function browse(dir) {
  if (!dir) {
    const places = [PROJECTS_ROOT, HOME, path.join(HOME, 'Desktop'), path.join(HOME, 'Documents'), path.join(HOME, 'Downloads')].filter(d => fs.existsSync(d));
    return { dir: '', parent: null, dirs: [...places, ...drives()].map(p => ({ name: p, path: p })) };
  }
  dir = path.resolve(dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('$') && !SKIP.has(e.name) && !/^(System Volume Information|Recovery)$/i.test(e.name))
    .map(e => ({ name: e.name, path: path.join(dir, e.name), git: fs.existsSync(path.join(dir, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? '' : parent, dirs, files: entries.filter(e => e.isFile()).length };
}
function addFolder(p) {
  p = path.resolve(String(p || ''));
  if (!fs.existsSync(p) || !fs.statSync(p).isDirectory()) throw new Error('That folder does not exist.');
  if (/^[a-z]:\\?$/i.test(p)) throw new Error('Pick a folder, not a whole drive.');
  projectCache = null;
  const known = projects().find(x => sameDir(x, p));
  if (known) return known;
  state.folders.push(p); persist(); projectCache = null;
  const real = checkProject(p);
  pinIt(real);   // a folder he just added starts out starred
  return real;
}
function removeFolder(p) {
  state.folders = state.folders.filter(f => !sameDir(f, p)); persist(); projectCache = null;
}
function makeFolder(parent, name) {
  name = String(name || '').trim();
  if (!name || /[<>:"/\\|?*]/.test(name) || /^\.+$/.test(name)) throw new Error('That is not a valid folder name.');
  const p = path.join(path.resolve(parent || PROJECTS_ROOT), name);
  if (fs.existsSync(p)) throw new Error('A folder with that name is already there.');
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function tidyQuick() {
  for (const p of quickChats()) {
    try { if (!fs.existsSync(chatFile(p)) && !fs.readdirSync(p).length && Date.now() - fs.statSync(p).mtimeMs > 864e5) fs.rmdirSync(p); } catch {}
  }
}
tidyQuick();
function newQuick() {
  const empty = quickChats().find(p => !chat(p).length && !runs.has(p));
  if (empty) return empty;
  const d = new Date(), pad = n => String(n).padStart(2, '0');
  let id = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  while (fs.existsSync(path.join(QUICK_DIR, id))) id += 'x';
  const p = path.join(QUICK_DIR, id);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// New project: a folder on one of the shelves in C:\Projects, git, and Claude starts the sketch.
const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
function shelves() { projects(); return placeCache; }

// A folder name from an idea, by plain rules.
const FILLER = new Set('a an the that which who what i im my me we our you to for of with and or but it its is are be been can could will would want wanna make build create app page website site tool thing something like so some shows show lets let how in on at into from about this just little simple quick kind sort where when hey hi yo look looking take see they them their there have has had new latest do does did get got go going'.split(' '));
const plainName = idea => slug(String(idea).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !FILLER.has(w)).slice(0, 3).join(' ')) || 'new-sketch';
async function newProject({ idea, name, shelf, pin, files }) {
  idea = String(idea || '').trim();
  if (!idea && !slug(name)) throw new Error('Give it a name first.');
  shelf = String(shelf || '');
  if (shelf && !shelves().includes(shelf)) throw new Error('That group folder is not in ' + PROJECTS_ROOT + '.');
  let base = slug(name) || plainName(idea);
  const parent = shelf ? path.join(PROJECTS_ROOT, shelf) : PROJECTS_ROOT;
  let n = base, i = 2;
  while (fs.existsSync(path.join(parent, n))) n = `${base}-${i++}`;
  const p = makeFolder(parent, n);
  await setupGit(p);
  projectCache = null;
  const real = checkProject(p);
  if (pin !== false) pinIt(real);   // starred unless he unticked it
  // Made from just a name: his first message in it gets the new-project brief.
  if (!idea) { state.projects[real] = { ...(state.projects[real] || {}), brandNew: true }; persist(); pushState(); return { path: real, error: null }; }
  let error = null;
  files = Array.isArray(files) ? files.map(String).slice(0, 20) : [];
  try { await sendMessage(real, idea, files, newProjectBrief({ idea, folder: real })); }
  catch (e) { error = String(e.message || e); }
  pushState();
  return { path: real, error };
}

// ---------------------------------------------------------------- chat history (per project)
const chatFile = p => path.join(CHATS_DIR, (isQuick(p) ? 'quick__' + path.basename(p) : workerOf(p) ? 'worker__' + path.basename(p) : projectName(p)).replace(/[\\/:*?"<>|]+/g, '__') + '.json');
const chats = new Map();
function chat(p) { if (!chats.has(p)) chats.set(p, readJson(chatFile(p), [])); return chats.get(p); }
function addChat(p, item) {
  const list = chat(p);
  item.t = Date.now();
  list.push(item);
  if (list.length > 1500) list.splice(0, list.length - 1500);
  writeJson(chatFile(p), list);
  send({ type: 'chat', project: p, item });
}
// Old conversations: archived as "<name>.<time>.json" next to the live one.
function pastChats(p) {
  const base = path.basename(chatFile(p), '.json');
  let names = [];
  try { names = fs.readdirSync(CHATS_DIR); } catch {}
  const out = [];
  for (const n of names) {
    const m = n.slice(base.length).match(/^\.(\d{10,})\.json$/);
    if (!n.startsWith(base) || !m) continue;
    const list = readJson(path.join(CHATS_DIR, n), []);
    const firstUser = list.find(i => i.kind === 'user' && i.text);
    const start = list.find(i => i.t)?.t || +m[1];
    out.push({ id: m[1], start, end: +m[1], count: list.filter(i => i.kind === 'user' || i.kind === 'assistant').length, title: String(firstUser?.text || '(no messages)').slice(0, 140) });
  }
  return out.sort((a, b) => b.end - a.end);
}
function pastChat(p, id) {
  if (!/^\d{10,}$/.test(String(id))) throw new Error('Unknown conversation.');
  const f = chatFile(p).replace(/\.json$/, `.${id}.json`);
  if (!fs.existsSync(f)) throw new Error('That conversation is gone.');
  return readJson(f, []);
}
function setPinned(p, on) {
  p = checkProject(p);
  state.pinned = state.pinned.filter(x => !sameDir(x, p));
  state.unstarred = state.unstarred.filter(x => !sameDir(x, p));
  if (on) state.pinned.push(p); else { state.unstarred.push(p); dotDismiss(p); }
  persist(); pushState();
}
// He dragged the sidebar into a new order. kind 'pinned' reorders main projects; 'quick' the quick chats.
function setOrder(kind, list) {
  list = Array.isArray(list) ? list.map(String) : [];
  if (kind === 'pinned') {
    const by = p => list.findIndex(x => sameDir(x, p));
    state.pinned = [...state.pinned].sort((a, b) => (by(a) < 0 ? 1e9 : by(a)) - (by(b) < 0 ? 1e9 : by(b)));
  } else if (kind === 'quick') state.quickOrder = list.filter(isQuick).slice(0, 500);
  else throw new Error('Unknown list.');
  persist(); pushState();
}
function archiveChat(p) {
  const f = chatFile(p);
  if (fs.existsSync(f) && chat(p).length) fs.renameSync(f, f.replace(/\.json$/, `.${Date.now()}.json`));
  chats.set(p, []);
}

// ---------------------------------------------------------------- uploads
const IMAGE_TYPES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
// What the page can show inline from a chat's show tool (pictures above, plus these).
const SHOW_IMAGE = { ...IMAGE_TYPES, '.svg': 'image/svg+xml', '.heic': 'image/heic', '.avif': 'image/avif', '.bmp': 'image/bmp' };
const SHOW_VIDEO = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/mp4' };
const SHOW_MAX = 200 * 1024 * 1024;
function saveUpload(name, buf) {
  const safe = (path.basename(String(name || 'file')).replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').slice(-120)) || 'file';
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(UPLOADS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, safe), buf);
  const ext = path.extname(safe).toLowerCase();
  return { id: `${id}/${safe}`, name: safe, size: buf.length, image: !!IMAGE_TYPES[ext] };
}
function uploadPath(id) {
  const p = path.resolve(UPLOADS_DIR, String(id || ''));
  if (!p.startsWith(UPLOADS_DIR + path.sep) || !fs.existsSync(p)) throw new Error('That attachment is gone.');
  return p;
}

// ---------------------------------------------------------------- git
async function git(cwd, ...args) {
  try { return (await execFileP('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true })).stdout; }
  catch (e) { return e.stdout || ''; }
}
async function setupGit(p) {
  await execFileP('git', ['init'], { cwd: p, windowsHide: true });
  const gi = path.join(p, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, ['node_modules/', '.env', '.env.*', '*.log', '.DS_Store', 'Thumbs.db', 'dist/', 'build/', '__pycache__/', '.venv/', ''].join('\n'));
  projectCache = null;
}
const branchCache = new Map();
async function branchOf(p) {
  if (!fs.existsSync(path.join(p, '.git'))) return null;
  const b = (await git(p, 'branch', '--show-current')).trim() || null;
  branchCache.set(p, b); return b;
}

// ---------------------------------------------------------------- accounts
const accById = id => state.accounts.find(a => a.id === id);
// If the server was started from inside a Claude Code session (the desktop app,
// a chat's terminal), it inherits that session's own login plumbing (a base URL,
// host auth refresh, its account uuid...) and every account then reads as "Not
// logged in". Only the account's own folder may decide the login.
const HOST_VARS = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|ANTHROPIC_.*|USE_(LOCAL|STAGING)_OAUTH)$/i;
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !HOST_VARS.test(k) && k.toUpperCase() !== 'CLAUDE_CONFIG_DIR'));
const envFor = a => ({ ...cleanEnv, CLAUDE_AGENT_SDK_CLIENT_APP: 'hydra/0.2', CLAUDE_CONFIG_DIR: a.configDir });
const ms = iso => (iso ? Date.parse(iso) : null);

// Work out from usage numbers whether (and until when) an account is out.
function deriveOut(a) {
  const now = Date.now();
  if (a.week?.util >= 100 && a.week.resetsAt > now) { a.outKind = 'weekly'; a.outUntil = a.week.resetsAt; }
  else if (a.five?.util >= 100 && a.five.resetsAt > now) { a.outKind = 'five_hour'; a.outUntil = a.five.resetsAt; }
  else if (a.outUntil && a.outUntil <= now) { a.outKind = null; a.outUntil = null; }
}
// The server said no. A weekly "no" while the week's numbers are not full is
// that model's own weekly limit (Opus, Sonnet...): the account stays open for
// the other models. Returns the reason, for the log and the chat.
function markOut(a, hit, model) {
  const { kind, until, type } = hit;
  const key = model || 'default';
  if (kind === 'weekly' && (type === 'seven_day_opus' || type === 'seven_day_sonnet' || (a.week?.util ?? 0) < 100)) {
    a.modelOut = { ...a.modelOut, [key]: { until: until || Date.now() + 7 * 24 * 3600 * 1000, type: type || null } };
    persist(); pushState();
    return `${a.id} hit its weekly limit for ${key} (resets ${fmtWhen(a.modelOut[key].until)}); it is still open for other models`;
  }
  a.outKind = kind; a.outSource = 'rejected';
  // If we do not know when it resets, assume 5 hours (short limit) or a week.
  a.outUntil = until || Date.now() + (kind === 'weekly' ? 7 * 24 : 5) * 3600 * 1000;
  if (kind === 'weekly') a.week = { util: 100, resetsAt: a.outUntil };
  else a.five = { util: 100, resetsAt: a.outUntil };
  persist(); pushState();
  return describeOut(a);
}
const isOut = a => !!(a.outUntil && a.outUntil > Date.now());
const modelBlocked = (a, model) => (a.modelOut?.[model || 'default']?.until || 0) > Date.now();
const isNear = a => (a.five?.util ?? 0) >= NEAR_FIVE || (a.week?.util ?? 0) >= NEAR_WEEK;
const usable = (a, model) => a.signedIn && !a.loginDead && !isOut(a) && !modelBlocked(a, model);
// A message failed with "not logged in / OAuth expired". The usage check keeps
// answering for such an account (account-1 looked fine while every message
// failed), so this mark stays until its login file changes, i.e. it was signed in again.
const credsTime = a => { try { return fs.statSync(path.join(a.configDir, '.credentials.json')).mtimeMs; } catch { return 0; } };
const AUTH_FAIL = /authenticat|oauth|not logged in|\/login|\b401\b/i;
function markLoginDead(a) {
  a.loginDead = { at: Date.now(), creds: credsTime(a) };
  a.error = 'Login expired: sign this account in again.';
  persist(); pushState();
  notify('An account needs signing in again', `${a.id} (${a.email || 'no email'}) was logged out. Open Accounts for the sign-in line.`);
  return `${a.id}'s login expired (it needs signing in again)`;
}
// Where to move a chat that is on account a, or null to stay. Out: anywhere
// usable. Only nearly out: only to one that is not nearly out too, otherwise
// two nearly-full accounts hand the chat back and forth after every reply.
function moveTarget(a, model) {
  if (a && usable(a, model) && !isNear(a)) return null;
  const next = pickAccount(a?.id, false, model);
  if (a && usable(a, model) && next && isNear(next)) return null;
  return next;
}

// The accounts don't all list the same models (some get an older menu, where
// "Fable" is an account-specific id for 5.1), but the short names work on all
// of them. So the lists are merged into one, and the menu shows the short names.
const MAIN_MODELS = ['default', 'opus', 'fable', 'sonnet', 'haiku'];
function mergeModels(list) {
  const byValue = new Map(state.models.map(m => [m.value, m]));
  for (const m of list) {
    const next = { value: m.value, name: m.displayName, description: m.description, efforts: m.supportedEffortLevels || [], resolved: m.resolvedModel || null };
    const old = byValue.get(m.value);
    // Keep the more informative entry ("Fable 5.2" beats "Fable").
    if (!old || /\d/.test(next.name) || !/\d/.test(old.name)) byValue.set(m.value, next);
  }
  state.models = [...byValue.values()];
}
// The short names first; anything else only if a project is set to it.
const menuModels = () => {
  const inUse = new Set([state.model, ...Object.values(state.projects).map(p => p.model)].filter(Boolean));
  const main = MAIN_MODELS.map(v => state.models.find(m => m.value === v)).filter(Boolean);
  return [...main, ...state.models.filter(m => !MAIN_MODELS.includes(m.value) && inUse.has(m.value))];
};
// Picks saved from the older menu ("claude-fable-5-1[1m]") become the short name.
const toShortName = v => { const f = /^claude-(opus|sonnet|haiku|fable)-.*\[1m\]$/.exec(v || ''); return f ? f[1] : v; };
state.model = toShortName(state.model);
for (const p of Object.values(state.projects)) if (p.model) p.model = toShortName(p.model);

// Read who the account is and how much is left, without sending a message.
// The same idle session also lists the models and slash commands on offer.
let refreshing = Promise.resolve();
function refreshAccount(a) {
  refreshing = refreshing.then(() => doRefresh(a)).catch(() => {});
  return refreshing;
}
async function doRefresh(a) {
  if (a.loginDead && credsTime(a) !== a.loginDead.creds) { a.loginDead = null; a.error = null; }   // signed in again
  if (!fs.existsSync(path.join(a.configDir, '.credentials.json'))) {
    Object.assign(a, { signedIn: false, email: null, error: null, checkedAt: Date.now() });
    pushState(); return;
  }
  let release;
  const idle = (async function* () { await new Promise(r => (release = r)); })();
  const q = query({ prompt: idle, options: { cwd: DATA_DIR, env: envFor(a), settingSources: [], permissionMode: 'default' } });
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), 45000));
  try {
    const [info, usage] = await Promise.race([Promise.all([
      q.accountInfo(),
      q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
    ]), timeout]);
    a.email = info?.email || a.email;
    a.signedIn = true; if (!a.loginDead) a.error = null;
    const rl = usage?.rate_limits;
    if (rl) {
      a.five = rl.five_hour ? { util: rl.five_hour.utilization ?? 0, resetsAt: ms(rl.five_hour.resets_at) } : a.five;
      a.week = rl.seven_day ? { util: rl.seven_day.utilization ?? 0, resetsAt: ms(rl.seven_day.resets_at) } : a.week;
    }
    // A "you're out" answer from the server stands until its reset time, unless
    // fresh numbers show that same window has clearly emptied (the limit was
    // reset early: account 1 sat "out" all day at 0% because of this).
    // Per-model weekly limits live in modelOut, so they are not affected.
    const win = a.outKind === 'weekly' ? a.week : a.five;
    const emptied = rl && (win?.util ?? 100) < (a.outKind === 'weekly' ? NEAR_WEEK : NEAR_FIVE);
    if (!(a.outSource === 'rejected' && a.outUntil > Date.now() && !emptied)) { a.outUntil = null; a.outKind = null; a.outSource = null; }
    deriveOut(a);
    try {
      const [models, cmds] = await Promise.race([Promise.all([q.supportedModels(), q.supportedCommands()]), timeout]);
      if (models?.length) mergeModels(models);
      if (cmds?.length) state.commands = cmds.map(c => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '' }));
    } catch { /* lists are a nice-to-have */ }
  } catch (e) {
    const msg = String(e.message || e);
    if (/log ?in|auth|credential|401/i.test(msg)) a.signedIn = false;
    a.error = msg.slice(0, 200);
  } finally {
    try { release?.(); q.close(); } catch {}
    a.checkedAt = Date.now();
    persist(); pushState();
  }
}
async function refreshAll() { for (const a of state.accounts) await refreshAccount(a); }

// Pick on purpose: among accounts that are not out, prefer ones not nearly
// out, then the one whose weekly allowance resets soonest (use it before it
// is wasted), so the others stay fresh for later.
function pickAccount(excludeId, peek = false, model = undefined) {
  // Test hook: force one account to be tried first even if it is out, to
  // exercise the "ran out mid-turn" path for real. Used once, then cleared.
  const forced = !peek && process.env.HYDRA_TEST_FORCE && accById(process.env.HYDRA_TEST_FORCE);
  if (forced && forced.id !== excludeId) { delete process.env.HYDRA_TEST_FORCE; return forced; }
  const cands = state.accounts.filter(a => a.id !== excludeId && usable(a, model));
  cands.sort((x, y) =>
    (isNear(x) - isNear(y)) ||
    ((x.week?.resetsAt ?? Infinity) - (y.week?.resetsAt ?? Infinity)) ||
    ((x.five?.util ?? 0) - (y.five?.util ?? 0)));
  return cands[0] || null;
}
function earliestReset() {
  const times = state.accounts.filter(a => a.signedIn && isOut(a)).map(a => a.outUntil);
  for (const a of state.accounts) for (const b of Object.values(a.modelOut || {})) if (a.signedIn && b.until > Date.now()) times.push(b.until);
  return times.length ? Math.min(...times) : null;
}
const fmtWhen = t => (t ? new Date(t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'unknown');
function describeOut(a) {
  return `${a.id} hit its ${a.outKind === 'weekly' ? 'weekly' : '5-hour'} limit (resets ${fmtWhen(a.outUntil)})`;
}

// ---------------------------------------------------------------- live conversations, one per project
// project path -> { project, accountId, q, push, busy, sessionId, lastUserMsg, answered, limitHit, stopping, perms, model, context, mode, setModel, effort, turnStart, idleSince }
// Each project has its own Claude Code process, so several can work at once.
const runs = new Map();
const anyBusy = () => [...runs.values()].some(r => r.busy);
const IDLE_CLOSE = 30 * 60 * 1000;   // close a conversation nobody has used for this long (it resumes on the next message)
// Every step re-reads the whole conversation, so a long one drains an account
// fast. Once a project chat is this big after a reply, Claude writes the note
// (cheap while it is still cached) and the next message starts a fresh chat.
const FRESH_AT = Number(process.env.HYDRA_FRESH_AT) || 100000;

function makeInput() {
  const queue = []; let wake = null; let closed = false;
  async function* gen() {
    while (!closed) {
      if (queue.length) { yield queue.shift(); continue; }
      await new Promise(r => (wake = r)); wake = null;
    }
  }
  return {
    iter: gen(),
    push(content) { queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, session_id: '' }); wake?.(); },
    close() { closed = true; wake?.(); },
  };
}

function extraInstructions(a) {
  // Profiles other than the default folder do not see the user's own CLAUDE.md,
  // so pass it along: his rules must follow him across accounts.
  if (sameDir(a.configDir, DEFAULT_CONFIG_DIR)) return '';
  try { return fs.readFileSync(GLOBAL_CLAUDE_MD, 'utf8'); } catch { return ''; }
}

const cut = (s, n) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + `\n… (${(s.length - n).toLocaleString()} more characters)` : s; };
const base = f => (f ? path.basename(String(f)) : '');

function toolLine(name, input = {}) {
  const f = base(input.file_path || input.path || input.notebook_path);
  switch (name) {
    case 'Bash': case 'PowerShell': return input.description ? String(input.description) : `Ran ${String(input.command || '').split('\n')[0].slice(0, 120)}`;
    case 'Edit': case 'MultiEdit': return `Edited ${f}`;
    case 'Write': return `Wrote ${f}`;
    case 'Read': return `Read ${f}`;
    case 'NotebookEdit': return `Edited notebook ${f}`;
    case 'Grep': return `Searched for "${String(input.pattern || '').slice(0, 60)}"`;
    case 'Glob': return `Looked for ${input.pattern || 'files'}`;
    case 'WebFetch': return `Read ${String(input.url || 'a web page').replace(/^https?:\/\//, '').slice(0, 80)}`;
    case 'WebSearch': return `Searched the web for "${input.query || ''}"`;
    case 'TodoWrite': return 'Updated the plan';
    case 'TaskCreate': return `Added a task: ${input.subject || input.title || input.description || ''}`.trim();
    case 'TaskUpdate': return 'Updated a task';
    case 'Agent': case 'Task': return `Sent a helper: ${input.description || input.subagent_type || ''}`.trim();
    case 'Skill': return `Used the ${input.skill || input.name || ''} skill`;
    case 'ExitPlanMode': return 'Finished the plan';
    case 'EnterPlanMode': return 'Switched to planning';
    case 'AskUserQuestion': return 'Asked you a question';
    case 'ToolSearch': return 'Loaded more tools';
    case 'mcp__screen__batch': return `Did ${(input.actions || []).length} screen steps: ${(input.actions || []).map(a => a.action).join(', ')}`;
    case 'mcp__hydra__new_chat': return 'Started a new chat for the next part';
    case 'mcp__hydra__start_worker': return `Started a worker: ${input.name || ''}`;
    case 'mcp__hydra__message_worker': return `Messaged worker ${input.worker || ''}`;
    case 'mcp__hydra__close_worker': return `Closed worker ${input.worker || ''}`;
    case 'mcp__hydra__show': return `Showed you ${(input.paths || []).map(p => base(p)).join(', ')}`;
    default: return name.startsWith('mcp__') ? `Used ${name.split('__').slice(1).join(' › ')}` : `Used ${name}`;
  }
}
function toolDetail(name, input = {}) {
  const file = input.file_path || input.notebook_path || input.path || null;
  switch (name) {
    case 'Bash': case 'PowerShell': return { kind: 'cmd', shell: name, text: cut(input.command, 4000) };
    case 'Edit': return { kind: 'diff', file, old: cut(input.old_string, 4000), new: cut(input.new_string, 4000) };
    case 'MultiEdit': return { kind: 'diff', file, old: cut((input.edits || []).map(e => e.old_string).join('\n⋯\n'), 4000), new: cut((input.edits || []).map(e => e.new_string).join('\n⋯\n'), 4000) };
    case 'Write': return { kind: 'write', file, text: cut(input.content, 4000) };
    case 'TodoWrite': return { kind: 'todos', todos: (input.todos || []).map(t => ({ text: t.content || t.subject || '', status: t.status })) };
    case 'Read': return { kind: 'file', file };
    default: return { kind: 'json', file, text: cut(JSON.stringify(input, null, 2), 2500) };
  }
}
function resultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(c => c.type === 'text' ? c.text : c.type === 'image' ? '[image]' : '').join('\n');
  return '';
}

function askLine(name, input = {}) {
  const f = input.file_path || input.path || input.notebook_path;
  if (name === 'Bash' || name === 'PowerShell') return 'run a command';
  if (['Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(name)) return `change ${f ? path.basename(String(f)) : 'a file'}`;
  if (name === 'WebFetch') return `open ${input.url || 'a web page'}`;
  if (name === 'WebSearch') return `search the web for "${input.query || ''}"`;
  return `use ${name}`;
}

// Mode, model and effort belong to each project; one it has never had uses the last ones picked.
function settingsFor(project) {
  const sp = state.projects[project] || {};
  return {
    mode: MODES.includes(sp.mode) ? sp.mode : state.mode,
    model: 'model' in sp ? sp.model : state.model,
    effort: 'effort' in sp ? sp.effort : state.effort,
  };
}
function saveSetting(project, key, value) {
  state[key] = value;   // the default for projects that have not picked yet
  if (project) state.projects[project] = { ...(state.projects[project] || {}), [key]: value };
  persist();
}

// Tools Hydra itself gives a project chat. new_chat: the chat closes after
// this reply and a fresh one starts from HANDOFF.md with the given first message.
// Copies files Claude wants the user to see into uploads and puts them in the chat,
// so they show up wherever he has the page open (his phone too).
function showFiles(r, paths, caption) {
  const files = [], problems = [];
  for (const raw of paths) {
    const p = path.resolve(r.project, String(raw).replace(/^["']|["']$/g, ''));
    let st = null; try { st = fs.statSync(p); } catch {}
    if (!st || !st.isFile()) { problems.push(`${raw}: no such file`); continue; }
    if (st.size > SHOW_MAX) { problems.push(`${raw}: too big (${Math.round(st.size / 1048576)} MB; the limit is ${SHOW_MAX / 1048576} MB)`); continue; }
    const f = saveUpload(path.basename(p), fs.readFileSync(p));
    (r.shown ||= new Set()).add(p.toLowerCase());
    const ext = path.extname(f.name).toLowerCase();
    files.push({ ...f, image: !!SHOW_IMAGE[ext], video: !!SHOW_VIDEO[ext] });
  }
  if (files.length) addChat(r.project, { kind: 'shared', text: String(caption || '').trim(), files, account: r.accountId });
  return files.length
    ? `Shown to ${NAME} in the chat: ${files.map(f => f.name).join(', ')}.${problems.length ? ' Not shown: ' + problems.join('; ') : ''}`
    : `Nothing shown. ${problems.join('; ')}`;
}

// The backstop for "show by default": pictures/videos a reply names by path (or file name in
// the project) that exist and weren't already shown this turn get shown under the reply.
const SHOW_EXT = Object.keys({ ...SHOW_IMAGE, ...SHOW_VIDEO }).map(e => e.slice(1)).join('|');
function autoShow(r) {
  const text = r.turnText || ''; r.turnText = '';
  const shown = r.shown || new Set(); r.shown = new Set();
  if (!text) return;
  const found = new Map();
  const add = raw => {
    const p = path.resolve(r.project, raw.trim().replace(/^file:\/\/\/?/i, ''));
    const k = p.toLowerCase();
    if (found.has(k) || shown.has(k) || found.size >= 8) return;
    try { if (fs.statSync(p).isFile()) found.set(k, p); } catch {}
  };
  const ext = `\\.(?:${SHOW_EXT})`;
  for (const m of text.matchAll(new RegExp('`([^`\\n]+' + ext + ')`', 'gi'))) add(m[1]);                  // `C:\some path\pic.png`
  for (const m of text.matchAll(new RegExp('\\]\\(([^)\\n]+' + ext + ')\\)', 'gi'))) { let u = m[1]; try { u = decodeURI(u); } catch {} add(u); } // [pic](pic.png)
  for (const m of text.matchAll(new RegExp('(?:[A-Za-z]:)?[\\w\\-.\\\\/]+' + ext + '\\b', 'gi'))) add(m[0]); // bare names
  if (found.size) showFiles(r, [...found.values()], '');
}

function makeChatServer(r, quick) {
  return createSdkMcpServer({
    name: 'hydra', version: '1.0.0',
    tools: [
      tool('show', "Show " + NAME + " pictures or files right in this chat: photos, screenshots, diagrams, plots, PDFs, videos, any file. They appear inline wherever he has Hydra open, including his phone, so this is THE way to show him an image. Give full paths, or paths relative to the project.",
        { paths: z.array(z.string()).min(1).max(12).describe('Files to show'), caption: z.string().optional().describe('A short line shown with them') },
        async a => ({ content: [{ type: 'text', text: showFiles(r, a.paths, a.caption) }] })),
      ...(quick ? [] : [tool('new_chat', "Start a new chat in this project once this reply ends. This chat closes, and the new one gets HANDOFF.md, the uncommitted changes and your message as its task. Use it when one part of the work is done and the next part is better started fresh (this chat is long or full of screenshots), or when " + NAME + " asks for a new chat. Update and commit HANDOFF.md BEFORE calling it, then end your reply with one short line to the user.",
        { message: z.string().min(1).describe('The first message of the new chat: the task, in a sentence or two, as ' + NAME + ' would say it') },
        async a => {
          r.newChat = a.message.trim();
          return { content: [{ type: 'text', text: 'OK. The new chat starts as soon as this reply ends. Finish now with one short line to ' + NAME + '.' }] };
        }),
      tool('start_worker', 'Start a worker: a separate Claude chat in its own copy of this project (a git worktree on a new branch from the last commit), doing one part of the job at the same time as you. Returns at once; its report arrives here as a message when it finishes. Commit first. Up to ' + MAX_WORKERS + ' open at once.',
        { name: z.string().min(1).max(40).describe('A short label, e.g. "dark mode"'), task: z.string().min(1).describe('The complete task: what to build, which files, what done looks like, how to check it. The worker does not see this chat.') },
        async a => text(await startWorker(r, a.name, a.task))),
      tool('message_worker', 'Send a follow-up message to one of your workers (it carries on in the same chat). Its answer arrives here as a message.',
        { worker: z.string().describe('The worker name'), message: z.string().min(1) },
        async a => text(await messageWorker(r, a.worker, a.message))),
      tool('close_worker', "Close a worker once its branch is merged (or not wanted): stops it and deletes its copy. Its branch is deleted if merged, kept otherwise unless discard is true.",
        { worker: z.string().describe('The worker name'), discard: z.boolean().optional().describe('Also delete its branch even if not merged') },
        async a => text(await closeWorker(r, a.worker, !!a.discard))),
      ]),
    ],
  });
}

const text = t => ({ content: [{ type: 'text', text: t }] });

// ---------------------------------------------------------------- workers
// A lead chat can start a few workers: separate chats, each in its own git worktree on
// its own branch, so they edit at the same time without clashing. A worker's finished
// reply goes to the lead as a message; the lead merges the branch and closes it.
const leadWorkers = lead => Object.entries(state.workers).filter(([, w]) => sameDir(w.lead, lead));
const findWorker = (lead, name) => {
  const n = String(name || '').trim().toLowerCase();
  return leadWorkers(lead).find(([p, w]) => w.name.toLowerCase() === n || w.branch.toLowerCase() === n || path.basename(p).toLowerCase() === n) || null;
};
const workersPending = lead => leadWorkers(lead).some(([, w]) => !w.reported);
const slugOf = t => String(t).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'worker';
async function gitOk(cwd, ...args) {
  try { return { ok: true, out: (await execFileP('git', args, { cwd, maxBuffer: 20 * 1024 * 1024, windowsHide: true })).stdout }; }
  catch (e) { return { ok: false, out: String(e.stderr || e.message || '').trim() }; }
}

// Leftover worker folders from closed workers (or a crash) are swept at startup.
function sweepWorkers() {
  let list = []; try { list = fs.readdirSync(WORKERS_DIR); } catch { return; }
  for (const d of list) { const p = path.join(WORKERS_DIR, d); if (!workerOf(p)) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} } }
}
sweepWorkers();

async function startWorker(r, name, task) {
  const lead = r.project;
  name = name.trim();
  if (workerOf(lead) || isQuick(lead)) return 'Only a project chat can start workers.';
  if (leadWorkers(lead).length >= MAX_WORKERS) return `You already have ${MAX_WORKERS} workers open (${leadWorkers(lead).map(([, w]) => w.name).join(', ')}). Close one first.`;
  if (!fs.existsSync(path.join(lead, '.git'))) return 'This project has no git yet, so workers cannot get their own copy. Run git init and make a first commit.';
  if (!(await gitOk(lead, 'rev-parse', '--verify', 'HEAD')).ok) return 'This project has no commits yet. Commit first: a worker copy starts from the last commit.';
  if (findWorker(lead, name)) return `There is already a worker called "${name}". Pick another name.`;
  const dirty = (await git(lead, 'status', '--short')).trim();
  const base = slugOf(path.basename(lead)), slug = slugOf(name);
  let n = 1, tail = slug;
  const taken = async t => fs.existsSync(path.join(WORKERS_DIR, `${base}-${t}`)) || (await gitOk(lead, 'rev-parse', '--verify', '--quiet', 'refs/heads/worker/' + t)).ok;
  while (await taken(tail)) tail = `${slug}-${++n}`;
  const branch = `worker/${tail}`, folder = path.join(WORKERS_DIR, `${base}-${tail}`);
  fs.mkdirSync(WORKERS_DIR, { recursive: true });
  const add = await gitOk(lead, 'worktree', 'add', '-b', branch, folder, 'HEAD');
  if (!add.ok) return 'Could not make the worker copy: ' + add.out.slice(0, 400);
  state.workers[folder] = { lead, name, branch, task, startedAt: Date.now() };
  const ls = settingsFor(lead);
  state.projects[folder] = { mode: ls.mode === 'plan' ? 'acceptEdits' : ls.mode, model: ls.model, effort: ls.effort };
  persist();
  addChat(lead, { kind: 'system', text: `Started worker "${name}" on its own copy (branch ${branch}).` });
  addChat(folder, { kind: 'user', text: 'From the lead: ' + task, files: [] });
  const a = accById(r.accountId);
  const account = a && usable(a, ls.model) && !moveTarget(a, ls.model) ? a : pickAccount(null, false, ls.model);
  if (!account) {
    waits.set(folder, { lastMessage: task, since: Date.now(), fromAccount: r.accountId });
    pushState();
    return `Worker "${name}" is set up (branch ${branch}) but every account is used up; it starts by itself at the next reset.`;
  }
  startRun({ project: folder, account, prompt: workerBrief({ name, task, branch, folder, leadFolder: lead }), resume: null, lastUserMsg: task });
  return `Worker "${name}" started. Branch: ${branch}. Its folder: ${folder}.${dirty ? ' Note: this folder has uncommitted changes; the worker does not have them.' : ''} Its report will arrive here as a message.`;
}

// Each lead takes its workers' reports one at a time, so two finishing together can't race.
const leadQueue = new Map();
function reportToLead(r, said, error) {
  const w = workerOf(r.project); if (!w) return;
  w.reported = true; persist();
  const msg = workerReport({ name: w.name, branch: w.branch, folder: r.project, report: cut(said, 6000), error });
  const next = (leadQueue.get(w.lead) || Promise.resolve()).then(async () => {
    if (!state.workers[r.project]) return;
    addChat(w.lead, { kind: 'system', text: `Worker "${w.name}" ${error ? 'stopped with an error' : 'finished'}; its report went to the lead.` });
    await sendMessage(w.lead, msg, [], null, { byClaude: true });
  }).catch(e => console.error('worker report', e));
  leadQueue.set(w.lead, next);
}

async function messageWorker(r, name, message) {
  const hit = findWorker(r.project, name);
  if (!hit) return `No worker called "${name}". Open ones: ${leadWorkers(r.project).map(([, w]) => w.name).join(', ') || 'none'}.`;
  const [folder, w] = hit;
  w.reported = false; persist();
  addChat(folder, { kind: 'user', text: 'From the lead: ' + message, files: [] });
  await sendMessage(folder, message, [], null, { byClaude: true });
  return `Sent to "${w.name}". Its answer will arrive here as a message.`;
}

async function closeWorker(r, name, discard) {
  const hit = findWorker(r.project, name);
  if (!hit) return `No worker called "${name}".`;
  return removeWorker(hit[0], discard);
}
async function removeWorker(folder, discard = false) {
  const w = state.workers[folder]; if (!w) return 'Already closed.';
  const run = runs.get(folder); if (run) await endRun(run);
  waits.delete(folder); unseen.delete(folder);
  const rm = await gitOk(w.lead, 'worktree', 'remove', '--force', folder);
  if (!rm.ok) { try { fs.rmSync(folder, { recursive: true, force: true }); } catch {} await gitOk(w.lead, 'worktree', 'prune'); }
  // Windows can keep the folder busy for a moment after Claude Code closes; try again shortly.
  setTimeout(() => { try { fs.rmSync(folder, { recursive: true, force: true }); } catch {} }, 5000);
  const del = await gitOk(w.lead, 'branch', discard ? '-D' : '-d', w.branch);
  delete state.workers[folder]; delete state.projects[folder]; chats.delete(folder);
  persist(); pushState();
  addChat(w.lead, { kind: 'system', text: `Closed worker "${w.name}".` });
  return `Closed "${w.name}" and deleted its copy. ${del.ok ? 'Branch ' + w.branch + ' deleted.' : 'Branch ' + w.branch + ' kept (it is not merged). Pass discard: true to delete it.'}`;
}

function startRun({ project, account, prompt, resume, lastUserMsg }) {
  const input = makeInput();
  const set = settingsFor(project);
  // Pin what this chat starts with to the project, so a pick made in another
  // project later can't change what its chip says while it keeps the old model.
  state.projects[project] = { ...set, ...(state.projects[project] || {}) };
  delete state.projects[project].freshNext;   // any new chat uses up the "start fresh next time" mark
  const r = {
    project, accountId: account.id, push: input.push, closeInput: input.close, busy: true,
    sessionId: null, lastUserMsg, answered: false, limitHit: null, stopping: false, perms: new Map(),
    model: null, context: null, startedAt: Date.now(), turnStart: Date.now(), idleSince: null,
    wantModel: set.model, wantEffort: set.effort, turnModel: set.model, warnedModel: null,
  };
  r.q = query({
    prompt: input.iter,
    options: {
      cwd: project,
      env: envFor(account),
      resume: resume || undefined,
      model: set.model || undefined,
      effort: set.effort || undefined,
      permissionMode: set.mode,
      includePartialMessages: true,
      additionalDirectories: [UPLOADS_DIR],   // so Claude can read what the user attaches
      systemPrompt: { type: 'preset', preset: 'claude_code', append: sessionRules(extraInstructions(account), isQuick(project), !!workerOf(project)) },
      settings: { includeCoAuthoredBy: false, attribution: { commit: '', pr: '' } },
      allowedTools: [
        'mcp__hydra__new_chat', 'mcp__hydra__show',
        'mcp__hydra__start_worker', 'mcp__hydra__message_worker', 'mcp__hydra__close_worker',
        ...['Bash', 'PowerShell'].flatMap(t => ['status', 'diff', 'log', 'add', 'commit'].map(g => `${t}(git ${g}:*)`)),
        `Read(${UPLOADS_DIR.replace(/\\/g, '/')}/**)`,
        ...(isQuick(project) ? ['WebSearch', 'WebFetch'] : []),
      ],
      mcpServers: { screen: makeScreenServer(), hydra: makeChatServer(r, isQuick(project) || !!workerOf(project)) },
      agents: { screen: SCREEN_AGENT },
      hooks: { PreToolUse: screenHook() },
      plugins: plugins(),
      canUseTool: (toolName, toolInput, opts) => askUser(r, toolName, toolInput, opts),
    },
  });
  runs.set(project, r);
  waits.delete(project);
  input.push(prompt);
  state.projects[project] = { ...(state.projects[project] || {}), accountId: account.id, sessionId: resume || state.projects[project]?.sessionId || null };
  persist(); pushState();
  consume(r);
  return r;
}

// Everything Claude needs the user for: a yes/no, a question with options, or a plan to approve.
function askUser(r, toolName, toolInput, opts) {
  // Screen control is asked once per chat, not before every click.
  const screen = toolName.startsWith(SCREEN_PREFIX);
  if (screen && r.screenOK) return Promise.resolve({ behavior: 'allow', updatedInput: toolInput });
  return new Promise(resolve => {
    const id = opts.toolUseID || crypto.randomBytes(6).toString('hex');
    const done = res => { r.perms.delete(id); pushState(); resolve(res); };
    let req;
    if (toolName === 'AskUserQuestion') {
      req = {
        id, kind: 'question', questions: (toolInput.questions || []).map(q => ({ question: q.question, header: q.header, multi: !!q.multiSelect, options: (q.options || []).map(o => ({ label: o.label, description: o.description || '' })) })),
        answer: answers => done({ behavior: 'allow', updatedInput: { ...toolInput, answers } }),
        resolve: allow => done(allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: NAME + ' skipped the question. Ask in plain words instead, or carry on with your best guess and say what you assumed.' }),
      };
    } else if (toolName === 'ExitPlanMode') {
      req = {
        id, kind: 'plan', plan: String(toolInput.plan || ''),
        resolve: allow => {
          if (allow && settingsFor(r.project).mode === 'plan') { saveSetting(r.project, 'mode', 'acceptEdits'); r.q.setPermissionMode('acceptEdits').catch(() => {}); }
          done(allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: NAME + ' wants to keep planning. Ask what should change in the plan.' });
        },
      };
    } else if (screen) {
      req = {
        id, kind: 'permission', tool: toolName, title: 'see and control your screen',
        detail: 'Screenshots, mouse and keyboard, for the rest of this chat. Press Stop to take it back.',
        diff: null, reason: '', canAlways: false,
        resolve: allow => {
          if (allow) r.screenOK = true;
          done(allow ? { behavior: 'allow', updatedInput: toolInput } : { behavior: 'deny', message: NAME + ' does not want you using the screen right now. Do it another way or give the steps instead.' });
        },
      };
    } else {
      const suggestions = opts.suggestions || [];
      req = {
        id, kind: 'permission', tool: toolName,
        title: opts.title || askLine(toolName, toolInput),
        detail: toolName === 'Bash' || toolName === 'PowerShell' ? String(toolInput.command || '') : (opts.description || toolInput.file_path || toolInput.url || ''),
        diff: ['Edit', 'Write', 'MultiEdit'].includes(toolName) ? toolDetail(toolName, toolInput) : null,
        reason: opts.decisionReason || '',
        canAlways: suggestions.length > 0,
        resolve: (allow, always) => done(allow
          ? { behavior: 'allow', updatedInput: toolInput, ...(always && suggestions.length ? { updatedPermissions: suggestions } : {}) }
          : { behavior: 'deny', message: NAME + ' said no to this. Ask what to do instead.' }),
      };
    }
    r.perms.set(id, req);
    opts.signal?.addEventListener('abort', () => { if (r.perms.has(id)) { r.perms.delete(id); pushState(); } });
    pushState();
    notify(req.kind === 'question' ? 'Claude has a question' : req.kind === 'plan' ? 'A plan is ready for you' : 'Claude is waiting for you',
      `${projectName(r.project)}: ${req.kind === 'question' ? req.questions[0]?.question || '' : req.kind === 'plan' ? 'approve it or keep planning' : req.title}`);
  });
}

function onRateLimit(r, info) {
  const a = accById(r.accountId);
  const w = info.unifiedWindows || {};
  if (w.five_hour) a.five = { util: Math.round((w.five_hour.utilization ?? 0) * 100), resetsAt: w.five_hour.resetsAt ? w.five_hour.resetsAt * 1000 : a.five?.resetsAt };
  if (w.seven_day) a.week = { util: Math.round((w.seven_day.utilization ?? 0) * 100), resetsAt: w.seven_day.resetsAt ? w.seven_day.resetsAt * 1000 : a.week?.resetsAt };
  if (info.status === 'rejected') {
    const kind = String(info.rateLimitType || '').startsWith('seven_day') ? 'weekly' : 'five_hour';
    r.limitHit = { kind, type: info.rateLimitType || null, until: info.resetsAt ? info.resetsAt * 1000 : null };
  }
  persist(); pushState();
}

// Live typing: forward the text and thinking as it streams. Not stored; the
// finished message replaces it.
function onStream(r, ev) {
  if (ev.type === 'content_block_start') {
    const t = ev.content_block?.type;
    if (t === 'text' || t === 'thinking') send({ type: 'stream', project: r.project, op: 'start', block: t });
  } else if (ev.type === 'content_block_delta') {
    if (ev.delta?.type === 'text_delta') send({ type: 'stream', project: r.project, op: 'delta', block: 'text', text: ev.delta.text });
    else if (ev.delta?.type === 'thinking_delta') send({ type: 'stream', project: r.project, op: 'delta', block: 'thinking', text: ev.delta.thinking });
  }
}

// Note which model really answered, and say so in the chat if it isn't the one picked.
function checkModel(r, actual) {
  if (!actual || actual.startsWith('<')) return;   // "<synthetic>" = not a real reply
  r.model = actual;
  // Compare with what was picked when this message went in (a pick made mid-reply starts with the next one).
  const want = state.models.find(m => m.value === (r.turnModel || 'default'))?.resolved;
  const strip = v => String(v).replace(/\[.*\]$/, '');
  if (!want || strip(want) === strip(actual) || r.warnedModel === actual) return;
  r.warnedModel = actual;
  const name = v => state.models.find(m => m.value !== 'default' && strip(m.resolved || '') === strip(v))?.name || v;
  addChat(r.project, { kind: 'system', text: `Heads up: you picked ${name(want)}, but this reply came from ${name(actual)}.` });
}

async function consume(r) {
  try {
    for await (const m of r.q) {
      if (m.type === 'system' && m.subtype === 'init') {
        r.sessionId = m.session_id; r.model = m.model || null;
        state.projects[r.project] = { ...(state.projects[r.project] || {}), accountId: r.accountId, sessionId: m.session_id };
        persist(); pushState();
      } else if (m.type === 'stream_event' && !m.parent_tool_use_id) {
        onStream(r, m.event);
      } else if (m.type === 'rate_limit_event') {
        onRateLimit(r, m.rate_limit_info);
      } else if (m.type === 'assistant' && m.parent_tool_use_id) {
        // A helper's steps: show its tool calls (not its words) so the user can follow along.
        for (const c of m.message?.content || []) {
          if (c.type === 'tool_use') addChat(r.project, { kind: 'tool', id: c.id, name: c.name, sub: true, text: 'Helper: ' + toolLine(c.name, c.input), detail: toolDetail(c.name, c.input) });
        }
      } else if (m.type === 'user' && m.parent_tool_use_id && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === 'tool_result') addChat(r.project, { kind: 'result', toolId: c.tool_use_id, error: !!c.is_error, text: cut(resultText(c.content), 2000) });
        }
      } else if (m.type === 'assistant' && !m.parent_tool_use_id) {
        if (m.error === 'rate_limit' && !r.limitHit) r.limitHit = { kind: 'five_hour', until: null };
        if (m.error === 'authentication_failed') r.authFailed = true;
        if (m.error) continue;
        checkModel(r, m.message?.model);
        for (const c of m.message?.content || []) {
          if (c.type === 'thinking' && c.thinking?.trim()) addChat(r.project, { kind: 'thinking', text: c.thinking });
          if (c.type === 'text' && c.text.trim()) { addChat(r.project, { kind: 'assistant', text: c.text, account: r.accountId }); r.turnText = (r.turnText || '') + '\n' + c.text; }
          if (c.type === 'tool_use') addChat(r.project, { kind: 'tool', id: c.id, name: c.name, text: toolLine(c.name, c.input), detail: toolDetail(c.name, c.input) });
        }
      } else if (m.type === 'user' && !m.parent_tool_use_id && Array.isArray(m.message?.content)) {
        for (const c of m.message.content) {
          if (c.type === 'tool_result') addChat(r.project, { kind: 'result', toolId: c.tool_use_id, error: !!c.is_error, text: cut(resultText(c.content), 5000) });
        }
      } else if (m.type === 'system' && m.subtype === 'local_command_output') {
        addChat(r.project, { kind: 'assistant', text: m.content, account: r.accountId, command: true });
      } else if (m.type === 'system' && m.subtype === 'ui_status') {
        if (r.status !== m.text) { r.status = m.text || ''; pushState(); }   // a mod's status line, e.g. token-diet's "ctx 22K 2% · $0.01"
      } else if (m.type === 'system' && m.subtype === 'compact_boundary') {
        addChat(r.project, { kind: 'system', text: 'Claude summarised the conversation so far to free up room.' });
      } else if (m.type === 'result') {
        r.busy = false; r.idleSince = Date.now();
        if (m.is_error && r.limitHit) break;              // account ran out mid-turn
        if (m.is_error && !r.interrupted && AUTH_FAIL.test(String(m.result || ''))) r.authFailed = true;
        if (m.is_error && r.authFailed) break;            // account is logged out: move on (below)
        r.authFailed = false;
        if (!m.is_error) r.limitHit = null;               // a warning, but the reply went through
        if (m.is_error && !r.interrupted) addChat(r.project, { kind: 'system', text: 'Claude stopped with an error: ' + String(m.result || m.subtype).slice(0, 400) });
        else if (!m.is_error) r.answered = true;
        const stoppedByUser = r.interrupted;
        r.interrupted = false;
        const said = (r.turnText || '').trim();
        if (!m.is_error && !stoppedByUser) { try { autoShow(r); } catch {} } else { r.turnText = ''; r.shown = new Set(); }
        const asWorker = !!workerOf(r.project);
        if (asWorker && !stoppedByUser && !r.stopping) reportToLead(r, said, m.is_error ? String(m.result || m.subtype).slice(0, 400) : null);
        send({ type: 'turn', project: r.project, ms: m.duration_ms, turns: m.num_turns });
        try { const c = await r.q.getContextUsage(); r.context = { pct: c.percentage, used: c.totalTokens, max: c.rawMaxTokens || c.maxTokens }; } catch {}
        pushState();
        const quiet = asWorker || workersPending(r.project);
        if (!quiet && !r.stopping && !stoppedByUser && !r.freshing && !r.newChat) unseen.add(r.project);
        if (!quiet && !r.stopping && !stoppedByUser && !r.freshing && !r.newChat) notify('Claude is done', `${projectName(r.project)} is waiting for your next message.`, r.project);
        afterTurn(r);
      }
    }
  } catch (e) {
    if (!r.limitHit && !r.stopping && AUTH_FAIL.test(String(e.message || e))) r.authFailed = true;
    if (!r.limitHit && !r.authFailed && !r.stopping) addChat(r.project, { kind: 'system', text: 'Claude Code stopped: ' + String(e.message || e).slice(0, 400) });
    if (!r.limitHit && !r.authFailed && !r.stopping && workerOf(r.project)) reportToLead(r, '', 'Claude Code stopped: ' + String(e.message || e).slice(0, 300));
  }
  if (runs.get(r.project) === r) {
    r.busy = false;
    for (const p of r.perms.values()) p.resolve(false);
    try { r.closeInput(); r.q.close(); } catch {}
    runs.delete(r.project);
    if (r.limitHit) {
      const a = accById(r.accountId);
      const why = markOut(a, r.limitHit, r.turnModel);
      await handOff(r, why, r.answered ? null : r.lastUserMsg);
    } else if (r.authFailed && !r.stopping) {
      const why = markLoginDead(accById(r.accountId));
      await handOff(r, why, r.lastUserMsg);
    }
    pushState();
  }
}

// After every finished turn: refresh the numbers and, if this account is
// nearly out, move on now, cleanly between steps, rather than mid-edit.
async function afterTurn(r) {
  await refreshAccount(accById(r.accountId));
  const a = accById(r.accountId);
  if (runs.get(r.project) === r && !r.busy && r.newChat) {
    // Claude asked for a new chat: close this one and start it (on whichever account is usable).
    const msg = r.newChat; r.newChat = null;
    await endRun(r);
    const sp = state.projects[r.project] || {};
    state.projects[r.project] = { ...sp, sessionId: null, freshNext: { size: r.context?.used || 0, byClaude: true } };
    persist();
    await sendMessage(r.project, msg, [], null, { byClaude: true });
    return;
  }
  if (runs.get(r.project) === r && !r.busy && moveTarget(a, r.turnModel)) {
    await endRun(r);
    const why = isOut(a) ? describeOut(a) : `${a.id} is nearly out (${a.five?.util ?? 0}% of 5-hour, ${a.week?.util ?? 0}% of weekly)`;
    await handOff(r, why, null);
    return;
  }
  if (runs.get(r.project) !== r || r.busy || isQuick(r.project) || workerOf(r.project)) return;
  if (r.freshing) {
    // The note is written: close this chat. The next message starts a fresh one.
    r.freshing = false;
    await endRun(r);
    const sp = state.projects[r.project] || {};
    state.projects[r.project] = { ...sp, sessionId: null, freshNext: { size: r.context?.used || 0 } };
    persist(); pushState();
  } else if ((r.context?.used || 0) >= FRESH_AT) {
    r.freshing = true;
    addChat(r.project, { kind: 'system', text: `This chat has grown to ${Math.round(r.context.used / 1000)}k tokens, and every step re-reads all of it. Claude is writing the handoff note now; your next message starts a fresh chat that reads only the note.` });
    r.busy = true; r.answered = false; r.lastUserMsg = null; r.idleSince = null;
    r.push(WRITE_NOTE_NOW); pushState();
  }
}

async function endRun(r) {
  r.stopping = true;
  for (const p of r.perms.values()) p.resolve(false);
  try { if (r.busy) await r.q.interrupt(); } catch {}
  try { r.closeInput(); r.q.close(); } catch {}
  if (runs.get(r.project) === r) runs.delete(r.project);
}

// Start a clean conversation on the next account, given only the note,
// the uncommitted changes, and the user's unanswered message.
async function handOff(r, why, lastMessage, excludeId = r.accountId) {
  const next = pickAccount(excludeId, false, r.turnModel);
  if (!next) {
    waits.set(r.project, { lastMessage, since: Date.now(), fromAccount: r.accountId });
    logSwitch(r.project, r.accountId, null, `${why}; every account is used up, waiting`);
    const at = earliestReset();
    addChat(r.project, { kind: 'switch', text: `All accounts are used up. Work picks up by itself at ${at ? new Date(at).toLocaleString() : 'the next reset'}.` });
    notify('All accounts are used up', `Work on ${projectName(r.project)} resumes ${at ? 'at ' + new Date(at).toLocaleTimeString() : 'at the next reset'}.`);
    pushState();
    return null;
  }
  logSwitch(r.project, r.accountId, next.id, why);
  return startHandoffOn(r.project, next, why, lastMessage, r.accountId);
}

async function startHandoffOn(project, account, why, lastMessage, fromId) {
  const wk = workerOf(project);
  if (wk) {
    const status = (await git(project, 'status', '--short')).trim();
    const done = (await git(project, 'log', '--oneline', `${wk.branch}`, '--not', '--exclude=refs/heads/worker/*', '--branches')).trim();
    const brief = workerBrief({ name: wk.name, task: wk.task, branch: wk.branch, folder: project, leadFolder: wk.lead })
      + `\n\nAn earlier chat started this task and stopped partway (${why}). Carry on from what is already in this folder.`
      + (done ? `\nCommits it made on this branch:\n${cut(done, 2000)}` : '')
      + (status ? `\nUncommitted changes:\n${cut(status, 2000)}` : '')
      + (lastMessage && lastMessage !== wk.task ? `\n\nThe last message it got from the lead:\n${lastMessage}` : '');
    addChat(project, { kind: 'switch', text: `Moved from ${fromId || '-'} to ${account.id}: ${why}`, brief });
    return startRun({ project, account, prompt: brief, resume: null, lastUserMsg: lastMessage });
  }
  if (isQuick(project)) {
    let transcript = chat(project).filter(i => (i.kind === 'user' || i.kind === 'assistant') && i.text)
      .map(i => (i.kind === 'user' ? (NAME + ': ') : 'Claude: ') + i.text).join('\n\n');
    if (lastMessage && transcript.endsWith((NAME + ': ') + lastMessage)) transcript = transcript.slice(0, -((NAME + ': ') + lastMessage).length).trim();
    if (transcript.length > 20000) transcript = '(earlier messages left out)\n\n' + transcript.slice(-20000);
    const brief = quickHandoffBrief({ reason: why, transcript, lastMessage });
    addChat(project, { kind: 'switch', text: `Moved from ${fromId || '-'} to ${account.id}: ${why}`, brief });
    return startRun({ project, account, prompt: brief, resume: null, lastUserMsg: lastMessage });
  }
  const note = (() => { try { return fs.readFileSync(path.join(project, HANDOFF_FILE), 'utf8'); } catch { return ''; } })();
  const isGit = fs.existsSync(path.join(project, '.git'));
  const status = isGit ? (await git(project, 'status', '--short')).trim() : '';
  const diff = isGit ? await git(project, 'diff', 'HEAD') : '';
  const brief = handoffBrief({ projectName: projectName(project), reason: why, note, status, diff, lastMessage });
  addChat(project, { kind: 'switch', text: `Moved from ${fromId || '-'} to ${account.id}: ${why}`, brief });
  return startRun({ project, account, prompt: brief, resume: null, lastUserMsg: lastMessage });
}

// The chat before this one got long and was closed after writing its note.
// Start a clean one from the note, with the user's new message (pictures kept).
async function startFreshOn(project, account, content, plain, size, byClaude = false) {
  const note = (() => { try { return fs.readFileSync(path.join(project, HANDOFF_FILE), 'utf8'); } catch { return ''; } })();
  const isGit = fs.existsSync(path.join(project, '.git'));
  const status = isGit ? (await git(project, 'status', '--short')).trim() : '';
  const diff = isGit ? await git(project, 'diff', 'HEAD') : '';
  const brief = handoffBrief({ projectName: projectName(project), reason: 'the last chat got long', note, status, diff, lastMessage: plain, fresh: byClaude ? 'claude' : true });
  addChat(project, { kind: 'switch', text: byClaude
    ? `Claude started a new chat on ${account.id} for the next part: "${cut(plain, 300)}". It starts from the handoff note.`
    : `Fresh chat on ${account.id}: the last one had grown to ${Math.round(size / 1000)}k tokens. This one starts from the handoff note.`, brief });
  const prompt = Array.isArray(content) ? [...content.filter(b => b.type !== 'text'), { type: 'text', text: brief }] : brief;
  return startRun({ project, account, prompt, resume: null, lastUserMsg: plain });
}

// ---------------------------------------------------------------- actions from the page
// A message is text plus any attachments. Pictures go to Claude directly;
// every attachment is also named by its path so it survives a handoff.
function buildContent(text, files) {
  if (!files.length) return { content: text, plain: text };
  const paths = files.map(f => uploadPath(f.id));
  const note = `\n\n[${NAME} attached ${files.length === 1 ? 'a file' : files.length + ' files'}. Saved at:\n${paths.map(p => '- ' + p).join('\n')}\nCopy them into the project if they belong there.]`;
  const plain = (text || '(no message, just the attachments)') + note;
  const blocks = [];
  for (const p of paths) {
    const mt = IMAGE_TYPES[path.extname(p).toLowerCase()];
    if (mt && fs.statSync(p).size <= 4.5 * 1024 * 1024) blocks.push({ type: 'image', source: { type: 'base64', media_type: mt, data: fs.readFileSync(p).toString('base64') } });
  }
  return { content: blocks.length ? [...blocks, { type: 'text', text: plain }] : plain, plain };
}

async function sendMessage(project, text, fileIds = [], promptOverride = null, { byClaude = false } = {}) {
  project = checkProject(project);
  const files = fileIds.map(id => { const p = uploadPath(id); return { id, name: path.basename(p), image: !!IMAGE_TYPES[path.extname(p).toLowerCase()] }; });
  // First message in a project made from just a name: it is the idea, so it gets the new-project brief.
  if (!promptOverride && !byClaude && state.projects[project]?.brandNew) {
    promptOverride = newProjectBrief({ idea: text, folder: project });
    const { brandNew, ...rest } = state.projects[project]; state.projects[project] = rest; persist();
  }
  const { content, plain } = buildContent(promptOverride || text, files);
  if (!byClaude) { addChat(project, { kind: 'user', text, files }); if (!['working', 'waiting'].includes(dotSeen.get(project))) dotDismiss(project); }
  unseen.delete(project);
  // Working on a project stars it (unless he unstarred it by hand before).
  if (!byClaude && !isQuick(project) && !workerOf(project) && !state.pinned.some(x => sameDir(x, project)) && !state.unstarred.some(x => sameDir(x, project))) { pinIt(project); pushState(); }

  const model = settingsFor(project).model;
  const cur = runs.get(project);
  if (cur) {
    const a = accById(cur.accountId);
    if (usable(a, model) && !moveTarget(a, model)) {
      if (!cur.busy) cur.turnStart = Date.now();
      cur.freshing = false;   // he wrote while the note was being written: carry on here, and try again after this reply
      cur.lastUserMsg = plain; cur.answered = false; cur.busy = true; cur.idleSince = null;
      await applyPicks(cur);
      cur.turnModel = cur.wantModel;
      cur.push(content); pushState(); return;
    }
    await endRun(cur);
  }

  const prev = state.projects[project];
  const prevAcct = prev && accById(prev.accountId);
  const account = (prevAcct && usable(prevAcct, model) && !moveTarget(prevAcct, model) && (prev.sessionId || prev.freshNext))
    ? prevAcct : pickAccount(null, false, model);
  if (!account) {
    waits.set(project, { lastMessage: plain, since: Date.now(), fromAccount: prev?.accountId || null });
    addChat(project, { kind: 'switch', text: 'Every account is used up right now. Your message will be sent by itself when the first one resets.' });
    pushState(); return;
  }
  if (prev?.freshNext && !isQuick(project)) {
    if (prev.accountId && prev.accountId !== account.id) logSwitch(project, prev.accountId, account.id, `the last chat was closed for being long, and ${prev.accountId} is not usable now`);
    await startFreshOn(project, account, content, plain, prev.freshNext.size, !!prev.freshNext.byClaude);
  } else if (prev?.sessionId && prev.accountId === account.id) {
    startRun({ project, account, prompt: content, resume: prev.sessionId, lastUserMsg: plain });   // same account: carry on that conversation
  } else if (prev?.accountId && prev.sessionId && prev.accountId !== account.id) {
    const old = accById(prev.accountId);
    const why = !old ? `${prev.accountId} no longer exists` : isOut(old) ? describeOut(old) : modelBlocked(old, model) ? `${old.id} hit its weekly limit for ${model || 'default'}` : isNear(old) ? `${old.id} is nearly out` : old.loginDead ? `${old.id}'s login expired` : `${old.id} is not signed in`;
    logSwitch(project, prev.accountId, account.id, why);
    await startHandoffOn(project, account, why, plain, prev.accountId);
  } else {
    startRun({ project, account, prompt: content, resume: null, lastUserMsg: plain });
  }
}

async function switchNow(project) {
  project = checkProject(project);
  const cur = runs.get(project) || null;
  const fromId = cur?.accountId || state.projects[project]?.accountId || null;
  const model = settingsFor(project).model;
  if (!pickAccount(fromId, false, model)) throw new Error('No other account is available right now.');
  const unanswered = cur && !cur.answered ? cur.lastUserMsg : (waits.get(project)?.lastMessage || null);
  if (cur) await endRun(cur);
  const next = pickAccount(fromId, false, model);
  logSwitch(project, fromId, next.id, NAME + ' pressed "Switch now"');
  await startHandoffOn(project, next, NAME + ' moved it to another account by hand', unanswered, fromId);
}

function writeNoteNow(project) {
  project = checkProject(project);
  const r = runs.get(project);
  if (!r) throw new Error('No conversation is running on this project, so there is nothing new to write down. The note is as current as the last session left it.');
  addChat(project, { kind: 'user', text: 'Write the handoff note now', files: [] });
  if (!r.busy) r.turnStart = Date.now();
  r.busy = true; r.answered = false; r.lastUserMsg = null; r.idleSince = null;
  r.push(WRITE_NOTE_NOW); pushState();
}

// A fresh conversation in the same folder. The page history is kept in an archive file.
async function newChat(project) {
  project = checkProject(project);
  const r = runs.get(project);
  if (r) await endRun(r);
  waits.delete(project);
  if (state.projects[project]) { state.projects[project].sessionId = null; delete state.projects[project].freshNext; }
  archiveChat(project); persist();
  send({ type: 'reset', project }); pushState();
}

async function stopNow(project) {
  project = checkProject(project);
  const r = runs.get(project);
  if (r?.busy) { r.interrupted = true; try { await r.q.interrupt(); } catch {} addChat(project, { kind: 'system', text: 'Stopped.' }); }
  if (waits.has(project)) { waits.delete(project); addChat(project, { kind: 'system', text: 'Stopped waiting for a reset.' }); }
  pushState();
}

// Settings change only the project they were picked in (and become the default for new ones).
const liveRun = project => (project ? runs.get(checkProject(project)) : null);
async function setMode(project, mode) {
  if (!MODES.includes(mode)) throw new Error('Unknown mode');
  const r = liveRun(project);
  saveSetting(project && checkProject(project), 'mode', mode);
  try { await r?.q.setPermissionMode(mode); } catch {}
  pushState();
}
async function setModel(project, model) {
  model = model || null;
  if (model && !state.models.some(m => m.value === model)) throw new Error('Unknown model');
  const r = liveRun(project);
  saveSetting(project && checkProject(project), 'model', model);
  if (r) await applyPicks(r);
  pushState();
}
async function setEffort(project, effort) {
  effort = effort || null;
  if (effort && !EFFORTS.includes(effort)) throw new Error('Unknown effort level');
  const r = liveRun(project);
  saveSetting(project && checkProject(project), 'effort', effort);
  if (r) await applyPicks(r);
  pushState();
}
// Make a running chat use the project's picked model and effort. Called when a
// pick is made and again before every message, so a pick that didn't take
// (e.g. made at an awkward moment) is retried instead of silently lost.
async function applyPicks(r) {
  const set = settingsFor(r.project);
  if (r.wantModel !== set.model) {
    try { await r.q.setModel(set.model || undefined); r.wantModel = set.model; r.warnedModel = null; }
    catch (e) { console.error('setModel failed:', e.message); }
  }
  if (r.wantEffort !== set.effort) {
    try { await r.q.applyFlagSettings({ effortLevel: set.effort }); r.wantEffort = set.effort; }
    catch (e) { console.error('effort change failed:', e.message); }
  }
}

// When every account is out: as soon as any one is usable again, pick each parked project back up.
// (Not "when earliestReset() has passed": that only counts accounts still out,
// so once the first one reset it pointed at the next one and nothing resumed.)
async function tick() {
  if (!waits.size) return;
  for (const [project, w] of [...waits]) {
    const model = settingsFor(project).model;
    const next = pickAccount(null, false, model);
    if (!next) continue;
    await refreshAccount(next);   // fresh numbers before trusting it (costs nothing)
    if (!usable(next, model)) continue;
    if (waits.get(project) !== w) continue;   // stopped or picked up meanwhile
    waits.delete(project);
    logSwitch(project, w.fromAccount, next.id, `${next.id} reset, picking the work back up`);
    notify('Back to work', `${next.id} has reset. Carrying on with ${projectName(project)}.`);
    await startHandoffOn(project, next, 'all accounts had run out; this one has now reset', w.lastMessage, w.fromAccount);
  }
}
// Conversations nobody has touched for a while are closed to free memory. The
// session id is kept, so the next message carries on where it left off.
function closeIdle() {
  for (const r of [...runs.values()]) {
    if (!r.busy && !r.perms.size && r.idleSince && Date.now() - r.idleSince > IDLE_CLOSE) { endRun(r).then(pushState); }
  }
}
setInterval(() => { tick().catch(() => {}); closeIdle(); }, 30000);
setInterval(() => { if (!anyBusy()) refreshAll(); }, REFRESH_EVERY);

// ---------------------------------------------------------------- phone access (Tailscale)
const tailnet = { name: null, ip: null, serving: false };
async function checkTailscale() {
  try {
    const { stdout } = await execFileP('tailscale', ['status', '--json'], { windowsHide: true, timeout: 8000 });
    const s = JSON.parse(stdout);
    tailnet.name = String(s.Self?.DNSName || '').replace(/\.$/, '') || null;
    tailnet.ip = s.Self?.TailscaleIPs?.find(x => x.includes('.')) || null;
  } catch { tailnet.name = null; }
  try {
    const { stdout } = await execFileP('tailscale', ['serve', 'status', '--json'], { windowsHide: true, timeout: 8000 });
    tailnet.serving = new RegExp(`127\\.0\\.0\\.1:${PORT}|localhost:${PORT}`).test(stdout);
  } catch { tailnet.serving = false; }
  pushState();
}

const findPerm = id => { for (const r of runs.values()) if (r.perms.has(id)) return r.perms.get(id); return null; };

function publicState() {
  const m = state.models.find(x => x.value === state.model);
  return {
    mode: state.mode, model: state.model, effort: state.effort, models: menuModels(), commands: state.commands,
    efforts: m?.efforts?.length ? m.efforts : EFFORTS,
    pinned: state.pinned.filter(known),
    quickOrder: state.quickOrder,
    accounts: state.accounts.map(a => ({
      id: a.id, label: a.label, email: a.email, signedIn: a.signedIn && !a.loginDead, loginDead: !!a.loginDead, configDir: a.configDir,
      five: a.five, week: a.week, out: isOut(a), outKind: isOut(a) ? a.outKind : null, outUntil: isOut(a) ? a.outUntil : null,
      near: isNear(a), checkedAt: a.checkedAt, error: a.error,
      modelOut: Object.entries(a.modelOut || {}).filter(([, b]) => b.until > Date.now()).map(([model, b]) => ({ model, until: b.until })),
      active: [...runs.values()].some(r => r.accountId === a.id), working: [...runs.values()].filter(r => r.accountId === a.id && r.busy).length,
    })),
    nextPick: pickAccount(null, true)?.id || null,
    runs: [...runs.values()].map(r => ({ project: r.project, accountId: r.accountId, busy: r.busy, model: r.model, context: r.context, status: r.status || '', turnStart: r.turnStart })),
    perms: [...runs.values()].flatMap(r => [...r.perms.values()].map(({ resolve, answer, ...p }) => ({ ...p, project: r.project }))),
    done: [...unseen],
    workers: Object.entries(state.workers).map(([p, w]) => ({ path: p, lead: w.lead, name: w.name, branch: w.branch, startedAt: w.startedAt, reported: !!w.reported })),
    waiting: [...waits].map(([project, w]) => ({ project, since: w.since, name: projectName(project) })),
    resumeAt: waits.size ? earliestReset() : null,
    projectAccounts: Object.fromEntries(Object.entries(state.projects).map(([k, v]) => [k, v.accountId])),
    projectSettings: Object.fromEntries(Object.keys(state.projects).map(k => [k, settingsFor(k)])),
    phone: { url: tailnet.name ? `https://${tailnet.name}` : null, serving: tailnet.serving, ip: tailnet.ip, port: PORT },
    log: logTail(),
  };
}

// ---------------------------------------------------------------- http
const PAGE = path.join(HERE, 'index.html');
// Changes whenever index.html does, so a page left open (his phone) reloads itself after an update.
// True when the server's own code changed on disk after it started: the page is new but the server is not.
const STARTED = Date.now();
const serverStale = () => ['server.mjs', 'prompts.mjs', 'screen.mjs', 'push.mjs'].some(f => { try { return fs.statSync(path.join(HERE, f)).mtimeMs > STARTED; } catch { return false; } });
const pageVersion = () => { try { return String(Math.round(fs.statSync(PAGE).mtimeMs)); } catch { return '0'; } };
// Files the page loads, served from this folder (no internet needed for them).
const VENDOR = {
  '/vendor/marked.js': 'node_modules/marked/marked.min.js',
  '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js',
  '/vendor/qrcode.js': 'node_modules/qrcode-generator/qrcode.js',
  '/icon.svg': 'icon.svg',
  '/icon-full.svg': 'icon-full.svg',
  '/apple-touch-icon.png': 'apple-touch-icon.png',
  '/icon-192.png': 'icon-192.png',
  '/icon-512.png': 'icon-512.png',
  '/manifest.json': 'manifest.json',
  '/sw.js': 'sw.js',
};
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/manifest+json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8',
  '.heic': 'image/heic', '.avif': 'image/avif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.csv': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8' };

// This PC, and this PC's own Tailscale name (what `tailscale serve` passes on).
const okHost = h => {
  h = String(h || '').toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || (!!tailnet.name && (h === tailnet.name.toLowerCase() || h === `${tailnet.name.toLowerCase()}:443`));
};
function body(req, limit = 2e6) {
  return new Promise((res, rej) => {
    let s = ''; req.on('data', c => { s += c; if (s.length > limit) { rej(new Error('Too big')); req.destroy(); } });
    req.on('end', () => { try { res(s ? JSON.parse(s) : {}); } catch (e) { rej(e); } });
    req.on('error', rej);
  });
}
function rawBody(req, limit) {
  return new Promise((res, rej) => {
    const parts = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { rej(new Error(`That file is too big (the limit is ${Math.round(limit / 1048576)} MB).`)); req.destroy(); } else parts.push(c); });
    req.on('end', () => res(Buffer.concat(parts)));
    req.on('error', rej);
  });
}
const json = (res, code, v) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(v)); };

const server = http.createServer(async (req, res) => {
  // Only this PC (directly or through its own tailscale serve), and only
  // pages served by this server, may talk to it.
  if (!okHost(req.headers.host)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (req.method === 'POST' && (!req.headers.origin || !okHost(req.headers.origin.replace(/^https?:\/\//, '')))) {
    if (req.headers.origin || req.headers['sec-fetch-site'] !== 'same-origin') { res.writeHead(403); res.end('Forbidden'); return; }
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(PAGE, 'utf8').replace('__PAGE_VERSION__', pageVersion())); return;
    }
    if (req.method === 'GET' && VENDOR[url.pathname]) {
      const f = path.join(HERE, VENDOR[url.pathname]);
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': /^\/(icon|apple|manifest|sw\.js)/.test(url.pathname) ? 'no-cache' : 'max-age=3600' });
      res.end(fs.readFileSync(f)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`data: ${JSON.stringify({ type: 'hello', page: pageVersion(), stale: serverStale() })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: 'state', state: publicState() })}\n\n`);
      clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/push/key') return json(res, 200, { key: push.publicKey, phones: push.count() });
    if (req.method === 'GET' && url.pathname === '/api/projects') {
      if (url.searchParams.get('rescan')) projectCache = null;
      return json(res, 200, [...projects(), ...quickChats(), ...workerPaths()].map(projectInfo));
    }
    if (req.method === 'GET' && url.pathname === '/api/shelves') {
      return json(res, 200, { root: PROJECTS_ROOT, shelves: shelves() });
    }
    if (req.method === 'GET' && url.pathname === '/api/chat') {
      const p = checkProject(url.searchParams.get('project'));
      return json(res, 200, { project: { ...projectInfo(p), branch: await branchOf(p) }, items: chat(p) });
    }
    if (req.method === 'GET' && url.pathname === '/api/past') {
      const p = checkProject(url.searchParams.get('project'));
      const id = url.searchParams.get('id');
      return json(res, 200, id ? { items: pastChat(p, id) } : pastChats(p));
    }
    if (req.method === 'GET' && url.pathname === '/api/browse') {
      return json(res, 200, browse(url.searchParams.get('dir') || ''));
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      const f = uploadPath(url.searchParams.get('id'));
      const size = fs.statSync(f).size;
      const head = { 'Content-Type': TYPES[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'max-age=86400', 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename="${path.basename(f).replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'" };
      // Byte ranges, so videos can seek (drag the bar, arrow keys) instead of only playing from the start.
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (m && size && (m[1] || m[2])) {
        let start = m[1] ? +m[1] : Math.max(0, size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], size - 1) : size - 1;
        if (start >= size || start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
        fs.createReadStream(f, { start, end }).pipe(res); return;
      }
      res.writeHead(200, { ...head, 'Content-Length': size });
      fs.createReadStream(f).pipe(res); return;
    }
    if (req.method === 'POST' && url.pathname === '/api/upload') {
      const buf = await rawBody(req, MAX_UPLOAD);
      if (!buf.length) throw new Error('That file is empty.');
      return json(res, 200, saveUpload(url.searchParams.get('name'), buf));
    }
    if (req.method === 'POST') {
      const b = await body(req);
      let out = { ok: true };
      switch (url.pathname) {
        case '/api/send': {
          const files = Array.isArray(b.files) ? b.files.map(String).slice(0, 20) : [];
          if (!String(b.text || '').trim() && !files.length) throw new Error('Type a message first.');
          await sendMessage(b.project, String(b.text || ''), files); break;
        }
        case '/api/permission': { const p = findPerm(b.id); if (p) p.resolve(!!b.allow, !!b.always); break; }
        case '/api/answer': { const p = findPerm(b.id); if (p?.answer) p.answer(b.answers || {}); break; }
        case '/api/switch': await switchNow(b.project); break;
        case '/api/note': writeNoteNow(b.project); break;
        case '/api/new': await newChat(b.project); break;
        case '/api/stop': await stopNow(b.project); break;
        case '/api/mode': await setMode(b.project, b.mode); break;
        case '/api/model': await setModel(b.project, b.model); break;
        case '/api/effort': await setEffort(b.project, b.effort); break;
        case '/api/refresh': refreshAll(); checkTailscale(); break;
        case '/api/pin': setPinned(b.project, !!b.on); break;
        case '/api/order': setOrder(b.kind, b.list); break;
        case '/api/folder/add': out = { path: addFolder(b.path) }; break;
        case '/api/folder/remove': removeFolder(b.path); break;
        case '/api/folder/new': { const p = makeFolder(b.parent, b.name); if (b.git) await setupGit(p); out = { path: addFolder(p) }; pinIt(checkProject(out.path)); break; }
        case '/api/push/subscribe': push.add(b.sub); break;
        case '/api/push/unsubscribe': push.remove(String(b.endpoint || '')); break;
        case '/api/push/test': out = await push.send({ title: 'Test alert', body: 'Alerts are working on this phone.' }, String(b.endpoint || '')); break;
        case '/api/worker/close': { const p = checkProject(b.project); if (!workerOf(p)) throw new Error('That is not a worker.'); out = { text: await removeWorker(p) }; break; }
        case '/api/seen': unseen.delete(checkProject(b.project)); pushState(); break;
        case '/api/quick/new': out = { path: newQuick() }; break;
        case '/api/project/new': out = await newProject(b); break;
        case '/api/run': out = await runCommand(b.project, b.cmd); break;
        case '/api/run-window': runInWindow(b.project, b.cmd); break;
        case '/api/git-init': { const p = checkProject(b.project); await setupGit(p); addChat(p, { kind: 'system', text: 'Git is set up for this project.' }); break; }
        default: return json(res, 404, { error: 'Not found' });
      }
      return json(res, 200, out);
    }
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    json(res, 400, { error: String(e.message || e) });
  }
});

server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Hydra may already be running: open http://${HOST}:${PORT}` : e);
  process.exitCode = 1;
});
server.listen(PORT, HOST, async () => {
  const url = `http://${HOST}:${PORT}`;
  await checkTailscale();
  console.log(`Hydra is running at ${url}  (close this window or press Ctrl+C to stop it)`);
  if (tailnet.name) console.log(tailnet.serving ? `On your phone: https://${tailnet.name}` : `Phone access is not switched on yet (see the phone button in the page).`);
  if (!process.argv.includes('--no-open')) spawn('cmd.exe', ['/c', 'start', '', url], { stdio: 'ignore', windowsHide: true }).on('error', () => {});
  refreshAll();
});
setInterval(() => { checkTailscale().catch(() => {}); }, 5 * 60 * 1000);
