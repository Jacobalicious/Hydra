# Hydra

A local web page for chatting with Claude Code about any folder in your
projects folder. When one Claude account runs out of usage, the chat moves to
your next account by itself and carries on from a handoff note.

Also: several projects at once, phone access and phone alerts, Claude can see
and use your screen (asks first), and chats can start helper chats.

## What you need
- **Windows 10 or 11** (the screen and shortcut parts are Windows-only)
- **Node.js 20 or newer**: https://nodejs.org (LTS), or `winget install OpenJS.NodeJS.LTS`
- **Git**: https://git-scm.com
- One or more **Claude Pro or Max** accounts (it is most useful with 2+)

## Set it up
1. Download it:
   ```
   git clone https://github.com/Jacobalicious/Hydra.git
   ```
2. Run the setup in that folder (Windows PowerShell):
   ```
   cd Hydra
   powershell -ExecutionPolicy Bypass -File .\setup.ps1
   ```
   It installs the parts, asks your name, your projects folder and how many
   accounts you have, then opens a browser to sign in each account once
   (use a different account each time). Last, it makes desktop and Start menu
   shortcuts.
3. Open **Hydra** from the desktop shortcut. The page is http://127.0.0.1:4517.

**Stop Hydra** is in the Start menu. Run `setup.ps1` again any time to
add an account or change your name or projects folder.

## Good to know
- Your settings and chats live in `%USERPROFILE%\.hydra`, not in this folder.
  `config.json` there has your name and projects folder.
- Rules you want every chat to follow go in `%USERPROFILE%\.claude\CLAUDE.md`
  (your normal Claude Code one); Hydra passes it to every account.
- Each project keeps a `HANDOFF.md` note so the next account can carry on.
- Update: `git pull`, then `npm.cmd install`, then Stop Hydra and open it again.
- Logs if something breaks: `%USERPROFILE%\.hydra\server-errors.log`.
