import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('./agent-tree-statusline.mjs', import.meta.url));
const scratch = path.join(os.tmpdir(), 'agent-tree-c9a');
fs.mkdirSync(scratch, { recursive: true });
const inner = [process.execPath, '-e', "console.log('L1');console.log('L2');console.log('L3')"];
const fresh = () => ({ v: 1, sessionId: 'fixture', updatedAt: Date.now(), lines: [{ forms: [[{ t: 'HUD', w: 3 }]] }] });

function fixture(t) {
  const config = fs.mkdtempSync(path.join(scratch, 'entry-'));
  t.after(() => fs.rmSync(config, { recursive: true, force: true }));
  const dir = path.join(config, 'agent-tree', 'hud');
  const put = (value = fresh(), name = 'fixture') => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${name}.json`), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const run = (args = inner, sessionId = 'fixture', extraEnv = {}, input = JSON.stringify({ session_id: sessionId })) => {
    const result = spawnSync(process.execPath, [entry, ...args], {
      input, env: { ...process.env, CLAUDE_CONFIG_DIR: config, COLUMNS: '120', ...extraEnv },
      encoding: 'utf8', timeout: 8000, windowsHide: true,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(result.error, undefined);
    return result.stdout;
  };
  const runOpen = (write, args = inner, nodeArgs = []) => {
    const start = performance.now();
    const child = spawn(process.execPath, [...nodeArgs, entry, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: config, COLUMNS: '120' },
      stdio: 'pipe', windowsHide: true,
    });
    const timers = [];
    t.after(() => {
      for (const timer of timers) clearTimeout(timer);
      child.stdin.destroy();
      child.stdout.resume();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; });
    // The reader can close its pipe while an oversized/trickling writer is still active.
    child.stdin.on('error', () => {});
    return new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        for (const timer of timers) clearTimeout(timer);
        child.stdin.destroy();
        try {
          assert.equal(code, 0);
          assert.equal(signal, null);
          assert.equal(stderr, '');
          resolve({ stdout, elapsed: performance.now() - start });
        } catch (error) { reject(error); }
      });
      write(child.stdin, (callback, delay) => timers.push(setTimeout(callback, delay)));
    });
  };
  return { config, dir, put, run, runOpen };
}

test('inner lines precede the HUD and receive the exact stdin and environment', t => {
  const { put, run } = fixture(t); put();
  assert.equal(run(), 'L1\nL2\nL3\nHUD\n');
  const input = '{ "session_id": "fixture", "extra": 1 }\n';
  assert.equal(run([process.execPath, '-e', "process.stdout.write(require('fs').readFileSync(0,'utf8'));process.stdout.write(process.env.COLUMNS)"], 'fixture', {}, input), `${input}120\nHUD\n`);
});
test('a missing trailing newline is added only before the first HUD line', t => {
  const { put, run } = fixture(t); put();
  assert.equal(run([process.execPath, '-e', "process.stdout.write('inner')"]), 'inner\nHUD\n');
});
test('a stale snapshot leaves only the inner output', t => {
  const { put, run } = fixture(t); put({ ...fresh(), updatedAt: Date.now() - 120001 });
  assert.equal(run(), 'L1\nL2\nL3\n');
});
test('another session snapshot leaves only the inner output', t => {
  const { put, run } = fixture(t); put({ ...fresh(), sessionId: 'other' });
  assert.equal(run(), 'L1\nL2\nL3\n');
});
test('bad snapshot JSON is silent', t => {
  const { put, run } = fixture(t); put('{'); assert.equal(run(), 'L1\nL2\nL3\n');
});
test('no snapshot directory is silent', t => {
  const { run } = fixture(t); assert.equal(run(), 'L1\nL2\nL3\n');
});
test('an inner exit 1 cannot suppress the HUD', t => {
  const { put, run } = fixture(t); put();
  assert.equal(run([process.execPath, '-e', "console.error('hidden');process.exit(1)"]), 'HUD\n');
});
test('an inner five-second sleep is cut at two seconds and the HUD survives', t => {
  const { put, run } = fixture(t); put();
  const start = Date.now();
  assert.equal(run([process.execPath, '-e', 'setTimeout(() => {}, 5000)']), 'HUD\n');
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 1900 && elapsed < 4000, `timeout elapsed ${elapsed} ms`);
});
test('no inner command prints the HUD alone', t => {
  const { put, run } = fixture(t); put(); assert.equal(run([]), 'HUD\n');
});
test('session id separators never build a snapshot path', t => {
  const { config, dir, put, run } = fixture(t); put();
  fs.writeFileSync(path.join(config, 'agent-tree', 'outside.json'), JSON.stringify({ ...fresh(), sessionId: '../outside' }));
  assert.equal(run([], '../outside'), '');
  assert.equal(run([], '..\\outside'), '');
  assert.equal(fs.existsSync(path.join(dir, '.cleanup')), false);
});
test('invalid session ids and bad stdin leave the inner output alone', t => {
  const { run } = fixture(t);
  for (const id of ['', '.', 'a'.repeat(129), 42, null]) assert.equal(run(inner, id), 'L1\nL2\nL3\n');
  assert.equal(run(inner, 'fixture', {}, '{'), 'L1\nL2\nL3\n');
});
test('missing program is silent and nonzero inner stdout is preserved exactly', t => {
  const { put, run } = fixture(t); put();
  assert.equal(run(['agent-tree-missing-program']), 'HUD\n');
  assert.equal(run([process.execPath, '-e', "process.stdout.write('partial');process.exit(1)"]), 'partial\nHUD\n');
});
test('config fallback: USERPROFILE, then HOME; empty config is unset', t => {
  const { config, put, run } = fixture(t);
  const dir = path.join(config, '.claude', 'agent-tree', 'hud');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fresh()));
  put({ ...fresh(), sessionId: 'wrong' });
  assert.equal(run([], 'fixture', { CLAUDE_CONFIG_DIR: '', USERPROFILE: config, HOME: 'unused' }), 'HUD\n');
  assert.equal(run([], 'fixture', { CLAUDE_CONFIG_DIR: '', USERPROFILE: '', HOME: config }), 'HUD\n');
});
test('cleanup deletes old regular JSON only, once per hour, without recursion', t => {
  const { dir, put, run } = fixture(t); put();
  put(fresh(), 'old'); put(fresh(), 'new');
  fs.writeFileSync(path.join(dir, 'keep.txt'), 'keep');
  fs.mkdirSync(path.join(dir, 'nested.json'));
  fs.writeFileSync(path.join(dir, 'nested.json', 'old.json'), 'keep');
  const old = new Date(Date.now() - 86401000);
  fs.utimesSync(path.join(dir, 'old.json'), old, old);
  assert.equal(run([]), 'HUD\n');
  assert.equal(fs.existsSync(path.join(dir, 'old.json')), false);
  assert.equal(fs.existsSync(path.join(dir, 'new.json')), true);
  assert.equal(fs.existsSync(path.join(dir, 'keep.txt')), true);
  assert.equal(fs.existsSync(path.join(dir, 'nested.json', 'old.json')), true);
  put(fresh(), 'old'); fs.utimesSync(path.join(dir, 'old.json'), old, old);
  run([]); assert.equal(fs.existsSync(path.join(dir, 'old.json')), true);
  const hour = new Date(Date.now() - 36001000); fs.utimesSync(path.join(dir, '.cleanup'), hour, hour);
  run([]); assert.equal(fs.existsSync(path.join(dir, 'old.json')), false);
});

test('one-piece JSON with stdin left open prints inner lines and the HUD', { timeout: 1500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const { stdout, elapsed } = await runOpen(stdin => stdin.write('{"session_id":"fixture"}'));
  assert.equal(stdout, 'L1\nL2\nL3\nHUD\n');
  assert.ok(elapsed < 750, `open stdin elapsed ${elapsed} ms`);
});
test('two-piece JSON 100 ms apart with stdin left open prints inner lines and the HUD', { timeout: 1500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const { stdout, elapsed } = await runOpen((stdin, later) => {
    stdin.write('{"session_id":');
    later(() => stdin.write('"fixture"}'), 100);
  });
  assert.equal(stdout, 'L1\nL2\nL3\nHUD\n');
  assert.ok(elapsed >= 100 && elapsed < 750, `split stdin elapsed ${elapsed} ms`);
});
test('nothing written with stdin left open gives the inner empty stdin after the no-data bound', { timeout: 750 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const args = [process.execPath, '-e', "require('assert').strictEqual(require('fs').readFileSync(0,'utf8'),'');console.log('L1');console.log('L2');console.log('L3')"];
  const { stdout, elapsed } = await runOpen(() => {}, args);
  assert.equal(stdout, 'L1\nL2\nL3\n');
  assert.ok(elapsed >= 250 && elapsed < 750, `no-data stdin elapsed ${elapsed} ms`);
});
test('invalid text trickled into open stdin stops at the overall read bound', { timeout: 1500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const { stdout, elapsed } = await runOpen((stdin, later) => {
    const trickle = () => {
      if (stdin.destroyed) return;
      stdin.write('x');
      later(trickle, 100);
    };
    trickle();
  });
  assert.equal(stdout, 'L1\nL2\nL3\n');
  assert.ok(elapsed >= 1000 && elapsed < 1500, `trickling stdin elapsed ${elapsed} ms`);
});
test('more than 256 KiB of open stdin leaves the inner lines only and exits zero', { timeout: 1500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const { stdout } = await runOpen(stdin => stdin.write('x'.repeat(256 * 1024 + 1)));
  assert.equal(stdout, 'L1\nL2\nL3\n');
});
test('the inner receives the exact UTF-8 text read before open stdin is released', { timeout: 1500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const input = '{ "session_id": "fixture", "extra": "字é" }\n';
  const args = [process.execPath, '-e', "process.stdout.write(require('fs').readFileSync(0,'utf8'));process.stdout.write(process.env.COLUMNS)"];
  const { stdout } = await runOpen((stdin, later) => {
    const bytes = Buffer.from(input);
    const split = bytes.indexOf(Buffer.from('字')) + 1;
    stdin.write(bytes.subarray(0, split));
    later(() => stdin.write(bytes.subarray(split)), 100);
  }, args);
  assert.equal(stdout, `${input}120\nHUD\n`);
});
test('the stdin size bound counts UTF-8 bytes rather than characters', { timeout: 750 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const { stdout, elapsed } = await runOpen(stdin => stdin.write('字'.repeat(90000)));
  assert.equal(stdout, 'L1\nL2\nL3\n');
  assert.ok(elapsed < 750, `oversized UTF-8 stdin elapsed ${elapsed} ms`);
});
test('an oversized JSON object cannot render the HUD', { timeout: 1500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const input = JSON.stringify({ session_id: 'fixture', extra: 'x'.repeat(256 * 1024) });
  const { stdout } = await runOpen(stdin => stdin.write(input));
  assert.equal(stdout, 'L1\nL2\nL3\n');
});
test('the total guard lets normal large inner output and the HUD drain after a bounded read', { timeout: 3500 }, async t => {
  const { put, runOpen } = fixture(t); put();
  const args = [process.execPath, '-e', "setTimeout(() => process.stdout.write('L'.repeat(256*1024)), 1600)"];
  const { stdout, elapsed } = await runOpen((stdin, later) => {
    stdin.write('{"session_id":');
    later(() => stdin.write('"fixture"}'), 900);
  }, args);
  assert.equal(stdout, `${'L'.repeat(256 * 1024)}\nHUD\n`);
  assert.ok(elapsed >= 2500 && elapsed < 3500, `normal output elapsed ${elapsed} ms`);
});
test('the total guard exits zero with complete output despite a lingering handle', { timeout: 4000 }, async t => {
  const { config, put, runOpen } = fixture(t); put();
  const preload = path.join(config, 'keep-alive.cjs');
  fs.writeFileSync(preload, 'setInterval(() => {}, 10000);\n');
  const { stdout, elapsed } = await runOpen(stdin => stdin.write('{"session_id":"fixture"}'), inner, ['--require', preload]);
  assert.equal(stdout, 'L1\nL2\nL3\nHUD\n');
  assert.ok(elapsed >= 2900 && elapsed < 3800, `total guard elapsed ${elapsed} ms`);
});

test('packed HUD lines follow byte-identical inner lines at the print width', t => {
  const { put, run } = fixture(t);
  const words = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE'];
  put({ ...fresh(), lines: [{ pack: {
    items: words.map(t => [{ t, w: t.length }]),
    sep: [{ t: '|', w: 1, d: true }],
    more: words.map((_, index) => [{ t: `+${index + 1} more`, w: 7, fg: '#58a6ff', d: true }]),
    maxLines: 2,
  } }] });
  const prefix = '\x1b[2mL1\x1b[0m\nL2\r\nL3\n';
  const args = [process.execPath, '-e', `process.stdout.write(${JSON.stringify(prefix)})`];
  assert.equal(run(args, 'fixture', { COLUMNS: '16' }), `${prefix}AAAA\x1b[2m|\x1b[0mBBBB\nCCCC\x1b[2m|\x1b[0m\x1b[38;2;88;166;255;2m+2 more\x1b[0m\n`);
  assert.equal(run(args, 'fixture', { COLUMNS: '13' }), `${prefix}AAAA\x1b[2m|\x1b[0mBBBB\n\x1b[38;2;88;166;255;2m+3 more\x1b[0m\n`);
});
