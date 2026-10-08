import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { renderLines } from './hud-print.mjs';

const NO_DATA_TIMEOUT_MS = 250;
const MAX_STDIN_BYTES = 256 * 1024;
const READ_TIMEOUT_MS = 1000;
const totalGuard = setTimeout(() => {
  process.exitCode = 0;
  process.exit(0);
}, 3000);
totalGuard.unref();

function readStdin(stream = process.stdin) {
  return new Promise(resolve => {
    let input = '', bytes = 0, done = false;
    let noDataTimer, readTimer;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(noDataTimer);
      clearTimeout(readTimer);
      try { stream.pause(); } catch { /* Releasing stdin is best effort. */ }
      try { stream.destroy(); } catch { /* A broken stream must not suppress output. */ }
      resolve(input);
    };
    try {
      if (stream.isTTY) { finish(); return; }
      noDataTimer = setTimeout(() => { if (bytes === 0) finish(); }, NO_DATA_TIMEOUT_MS);
      readTimer = setTimeout(finish, READ_TIMEOUT_MS);
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        input += chunk;
        bytes += Buffer.byteLength(chunk, 'utf8');
        if (bytes > MAX_STDIN_BYTES) { finish(); return; }
        try {
          const value = JSON.parse(input);
          if (value !== null && typeof value === 'object' && !Array.isArray(value)) finish();
        } catch { /* Wait for more text, end, or the read bound. */ }
      });
      stream.on('end', finish);
      stream.on('error', finish);
    } catch { finish(); }
  });
}

function cleanup(dir, now) {
  try {
    if (fs.lstatSync(dir).isSymbolicLink()) return;
    const marker = path.join(dir, '.cleanup');
    let stamp;
    try { stamp = fs.lstatSync(marker); } catch { /* First sweep. */ }
    if (stamp?.isSymbolicLink() || (stamp && now - stamp.mtimeMs <= 3600000)) return;
    fs.writeFileSync(marker, '');
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs > 86400000) fs.unlinkSync(file);
    }
  } catch { /* Cleanup is optional. */ }
}

try {
  const input = await readStdin();
  const [program, ...args] = process.argv.slice(2);
  let output = '';
  if (program) {
    try {
      const result = spawnSync(program, args, {
        input, env: process.env, encoding: 'utf8', timeout: 2000,
        windowsHide: true, maxBuffer: 1024 * 1024,
      });
      output = result.stdout ?? '';
      process.stdout.write(output);
    } catch { /* The HUD still gets its turn. */ }
  }
  try {
    const sessionId = Buffer.byteLength(input, 'utf8') <= MAX_STDIN_BYTES ? JSON.parse(input)?.session_id : undefined;
    if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
      const config = process.env.CLAUDE_CONFIG_DIR ||
        path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.claude');
      const dir = path.join(config, 'agent-tree', 'hud');
      const now = Date.now();
      cleanup(dir, now);
      const snapshot = JSON.parse(fs.readFileSync(path.join(dir, `${sessionId}.json`), 'utf8'));
      const lines = renderLines(snapshot, sessionId, process.env.COLUMNS, now);
      if (lines.length > 0) process.stdout.write(`${output && !output.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`);
    }
  } catch { /* Missing or unreadable snapshots leave the inner output alone. */ }
} catch { /* Status lines must never fail the session. */ }
process.exitCode = 0;
