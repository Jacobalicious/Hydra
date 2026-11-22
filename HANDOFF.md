## Done
- Keep going: project chats call mcp__hydra__keep_going when work isn't done and nothing needs the owner; Hydra sends "carry on" after the reply (also after the long-chat note, in the fresh chat, and across account switches). Cap HYDRA_KEEP_GOING_MAX (30) carry-ons per user message. Not yet tried in a real chat.
- Sidebar: workers have an X (close) and a blue dot once reported; reported workers whose branch is merged close themselves after the lead's turn. Last 3 quick chats show with an X (hides + stops; state.quickHidden; a new message unhides).
- Renamed to Hydra (page, app name, shortcuts, setup, env vars HYDRA_*). Public at github.com/Jacobalicious/Hydra (one squashed commit, no personal info).
- Shareable: name + projects folder come from config.json in the data folder (me.mjs, never hardcode a name); setup.ps1 + README set up a new PC.
- token-diet is built in (plugins/token-diet), loaded in every chat.
- Data folder is ~/.hydra, falling back to an existing ~/.multiclaude (where the owner's logins and chats live).
- Workers: a project chat can start up to 3 parallel workers (own git worktree + branch). Reports go back to the lead, which merges and closes them.
- Every chat gets REPLY_STYLE (short, bullets); project chats start workers on their own when a job splits.

## In progress
- Nothing half-done. the owner still has to switch over: run launcher/install-shortcuts.ps1 (swaps MultiClaude shortcuts for Hydra ones, keeps start-at-sign-in), stop the old server once, then open Hydra. Don't restart from inside a chat; it kills the chat.

## Next
- Restart Hydra (stop.ps1 -Force, start.ps1, from outside a chat) and watch a real chat use keep_going.
- Confirm with the owner that Hydra opens with all projects/accounts after the switch.
- setup.ps1 has never run on a fresh PC: a friend is the first real test; fix whatever they hit.
- No real chat has run with the built-in token-diet yet: check its status line shows in a chat.
- Optional: parked messages (`waits`) live only in memory; persist them if a restart dropping them bites.

## Must know
- Full old history is local only, on branch private-history (has personal info): never push it.
- The repo is public: no personal names, paths, emails or keys in tracked files. Prompts use NAME from me.mjs.
- token-diet in plugins/ is a copy; changes in the separate token-diet project don't flow in unless copied.
- The status-dot files in ~/.claude/status-dot keep the "multiclaude-" prefix on purpose (an outside tray tool reads them).
- The local folder is still named MultiClaude; only the app and repo were renamed.
- Outside auto mode, the lead's git merge still asks the user first; workers copy the lead's mode (plan becomes acceptEdits).
- Worker folders: Windows keeps them busy briefly after close, so removal retries after 5 s and leftovers are swept at startup.
- earliestReset() only counts accounts that are still out, so never use "has it passed" as a gate.
