## Done
- Workers: a project chat can start up to 3 parallel workers (own git worktree + branch each, same account). Reports flow back to the lead, which merges and closes them. Sidebar has a "Workers" group; a worker's chat has a "Close worker" button. Tested end to end on a spare port (2 workers, both merged, both closed).
- Parked work resumes as soon as any one account is usable again (tick() in server.mjs).
- Terminal button on shell code blocks opens a real PowerShell window in the project folder.

- Every chat (project, quick, worker) now gets REPLY_STYLE (short, bullets) at the top of its rules; project chats are told to start workers on their own when a job splits into separate parts (prompts.mjs).

## In progress
- Nothing. Needs a server restart (stop.ps1 -Force, then start.ps1); not done from inside a chat because that kills the chat.

## Next
- Look at the Workers sidebar group in the real page (not checked visually yet).
- Optional: parked messages (`waits`) live only in memory; persist them if a restart dropping them bites.

## Must know
- Outside auto mode, commands like the lead's git merge still ask the user first; workers copy the lead's mode (plan becomes acceptEdits).
- Worker folders: Windows keeps them busy briefly after close, so removal retries after 5 s and leftovers are swept at startup.
- earliestReset() only counts accounts that are still out, so never use "has it passed" as a gate.
