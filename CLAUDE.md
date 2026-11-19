# MultiClaude

A local Node server + one HTML page
that lets the user chat with Claude Code about any folder in `C:\Projects`, and
moves the work to another of the user's Claude Pro accounts when one runs out.
Keep it small: no framework, no build step.

## Layout
- `server.mjs` — everything server-side: account usage, picking/switching
  accounts, the live conversations (one Agent SDK `query()` with streaming
  input per project, in the `runs` map, so several projects can work at once;
  idle ones close after 30 min and resume from their session id), approvals,
  switch log, Windows toasts, HTTP + server-sent events. Mode/model/effort are
  per project (`state.projects[p]`), defaulting to the last ones picked.
- `index.html` — the whole page, vanilla JS, talks to `/api/*`.
- `screen.mjs` + `screen.ps1` — computer use for chats (the SDK doesn't get the desktop
  app's): an in-process MCP server `screen` (screenshot, click, type, key, hold_key…)
  driving one long-lived hidden PowerShell that does the Win32 input. Asked once per chat.
  To save allowance the main chat may only *look* (screenshot, zoom, windows); a PreToolUse
  hook sends every click/type/key to the `screen` subagent (Sonnet, low effort, own context,
  `SCREEN_AGENT`), and forces all subagents to run in the foreground so "done" means done.
  Screenshots are 1024x640; `zoom` reads small text; `batch` = several actions, one screenshot.
  SDK gotcha: one invalid field in `agents` (e.g. `autoCompactWindow` < 100000) silently
  drops *every* custom agent; the CLI debug log says "Error parsing agents".
- `mcp__multiclaude__new_chat` (in server.mjs, project chats only): Claude closes its own chat
  after the reply and starts a fresh one from HANDOFF.md with the task it gave.
- Workers (`start_worker` / `message_worker` / `close_worker`, project chats only): the lead chat
  starts up to 3 separate chats, each in a git worktree under `~/.multiclaude/workers/` on branch
  `worker/<name>`, on the lead's account. They are ordinary runs keyed by the worktree path
  (`state.workers[path]` = lead, name, branch, task). A worker's finished reply goes to the lead as
  a message (`reportToLead`, queued per lead); the lead merges and closes. Workers get
  `WORKER_RULES`, never ping the user, and the lead's "done" alert waits until all its workers reported.
- `mcp__multiclaude__show` (every chat): copies files into `uploads/` and adds a `shared` chat item,
  so pictures/videos/files show inline on any device (a phone via Tailscale). Backstop
  (`autoShow`): at the end of a turn, pictures/videos the reply names that exist and weren't shown get shown.
- Phone alerts: `push.mjs` (Web Push done with node:crypto, no package; keys + phone
  subscriptions in `push.json` in the data folder) and `sw.js` (the service worker that shows
  them). Every `notify()` goes to Windows toasts, open pages, and every subscribed phone. The
  phone opts in from the phone button ("Alert me on this phone"); iPhone only from the
  home-screen icon. `new Notification()` does nothing on phones, which is why this exists.
- The page reloads itself when `index.html` changed since it loaded (`hello` event on the event
  stream carries its mtime), so a phone left open doesn't keep running an old page after a restart.
- `me.mjs` — whose copy this is: `NAME` (said in every prompt) and `PROJECTS_ROOT`, from
  `config.json` in the data folder (written by `setup.ps1`, the first-time setup for a friend's PC;
  README.md is for them). Without it: the Windows user name and `C:\Projects`. Never hardcode a person's name
  in a prompt string; use `NAME`.
- `prompts.mjs` — every word said to Claude (session rules, handoff brief,
  "write the note now"). The probes import it too.
- `probes/` — the throwaway risk-check scripts from the first session. Still
  runnable; useful when Claude Code updates and something looks off.

## Run
`npm install` once. The user starts it from the **MultiClaude** shortcut (desktop / Start menu)
or `MultiClaude.cmd`: both run `launcher/start.ps1`, which starts the server hidden in the
background (output in `~/.multiclaude/server.log` and `server-errors.log`) if it is not
already up, then opens http://127.0.0.1:4517. **Stop MultiClaude** (Start menu,
`launcher/stop.ps1`, `-Force` for no prompts) kills it and its Claude Code processes, no questions asked.
`launcher/install-shortcuts.ps1` (re)makes the shortcuts; `-AtLogin` / `-NoLogin`
adds/removes starting at Windows sign-in. To restart after a code change:
`stop.ps1 -Force` then `start.ps1`. Both honour `MULTICLAUDE_PORT` (and start.ps1
`MULTICLAUDE_DATA`), so they can be tested on a spare port.
**Don't start the real one with `node server.mjs` inside a Claude chat's terminal tab or a
background Bash**: it dies when that chat closes (that is what took the site down once).
`node server.mjs` in a visible window is still the way to watch it for debugging.
Not `npm start`:
Windows PowerShell often blocks `npm.ps1` (script execution is disabled), so give
`node server.mjs` (or `npm.cmd start`).
Test copy without touching real data: set `MULTICLAUDE_PORT`, `MULTICLAUDE_DATA`
(data folder) and `MULTICLAUDE_PROJECTS` (projects root) and add `--no-open`.
`MULTICLAUDE_FRESH_AT=30000` lowers the size (default 100k tokens) at which a project
chat writes its note and closes, so the next message starts fresh; handy for testing that.
`MULTICLAUDE_TEST_FORCE=account-N` makes the next pick use that account even if
it is out, to exercise the real "ran out mid-message" path.
`.claude/launch.json` has a preview config. Take screenshots at scale 0.5.

## Data (outside the repo, `%USERPROFILE%\.multiclaude`)
`accounts.json` (id + configDir per account; JSON, so backslashes doubled),
`state.json` also holds `pinned` (their "main projects", top of the sidebar),
`chats/<name>.<time>.json` = past conversations (shown read-only from the ⋯ menu),
`quick/<time>/` = one empty scratch folder per quick chat (questions that are not a project;
they get `QUICK_RULES` from prompts.mjs and may search the web; their chat file is `chats/quick__<time>.json`),
`account-1..3/` (each account's own Claude Code config folder = its login),
`state.json`, `switch-log.txt`, `chats/` (page history per project).

## Things that will trip you up
- **Never point an account at `%USERPROFILE%\.claude`.** Its login changes when
  the user switches accounts in their normal Claude Code. Each account needs its own
  folder, signed in once with `CLAUDE_CONFIG_DIR` set (`claude auth login`).
- The **email** Claude Code reports per folder is cached and can be stale; the
  usage numbers are the trustworthy signal of which account a folder is.
- Usage without spending anything: open a `query()` with a never-yielding prompt
  and call `accountInfo()` + `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()`.
  That method is experimental; if it breaks after an SDK update, the
  `rate_limit_event` messages (status `rejected`, `rateLimitType`, `resetsAt` in
  seconds, `unifiedWindows` utilization as 0–1) still drive switching.
- After an error result (e.g. rate limit) the SDK's iterator **throws**; that is
  normal and is caught in `consume()`.
- Folders other than `~/.claude` don't load the user's global CLAUDE.md, so the
  server appends it to the system prompt, and passes attribution-off settings.
  Commits must never carry a Claude trailer.
- Never `process.exit()`; set `process.exitCode`.

token-diet: every chat loads the built-in mod in `plugins/token-diet` (override with `MULTICLAUDE_DIET`; silently skipped if missing). It clears/compacts context on its own and halves screenshot size. Its `ui_status` line shows beside the chips; `/diet` replies as local_command_output.
