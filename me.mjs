// Who this copy of MultiClaude belongs to, and where their projects live.
// Read from config.json in the data folder (setup.ps1 writes it):
//   { "name": "Sam", "projectsRoot": "C:\Projects" }
// Without it: the Windows user name, capitalised, and C:\Projects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DATA_DIR = process.env.MULTICLAUDE_DATA || path.join(os.homedir(), '.multiclaude');
const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8')); } catch { return {}; } })();
const user = os.userInfo().username || 'you';
export const NAME = String(cfg.name || user.charAt(0).toUpperCase() + user.slice(1)).trim();
export const PROJECTS_ROOT = process.env.MULTICLAUDE_PROJECTS || cfg.projectsRoot || 'C:\\Projects';
