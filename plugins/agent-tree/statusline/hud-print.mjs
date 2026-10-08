// Display-only snapshot rendering. No I/O and no terminal escapes from text.
export function formatDuration(ms) {
  if (ms === undefined || !Number.isFinite(ms)) return '--';
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  const two = value => String(value).padStart(2, '0');
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${two(seconds % 60)}s`;
  return `${Math.floor(seconds / 3600)}h${two(Math.floor(seconds / 60) % 60)}m`;
}

function charWidth(code) {
  if (code < 0x20 || (code >= 0x7f && code < 0xa0) ||
      (code >= 0x300 && code <= 0x36f) || (code >= 0x200b && code <= 0x200f) || code === 0xfe0f) return 0;
  return ((code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) || (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) || (code >= 0x20000 && code <= 0x3fffd)) ? 2 : 1;
}

const plain = text => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');

function runValue(run, now) {
  if (run === null || typeof run !== 'object') throw new Error('invalid run');
  if ('since' in run) {
    if (!Number.isFinite(run.since)) throw new Error('invalid start');
    const text = formatDuration(now - run.since);
    return { text, width: text.length, style: run };
  }
  if (typeof run.t !== 'string' || !Number.isInteger(run.w) || run.w < 0) throw new Error('invalid text');
  return { text: plain(run.t), width: run.w, style: run };
}

function styled({ text, style }) {
  const codes = [];
  if (typeof style.fg === 'string' && /^#[0-9a-f]{6}$/i.test(style.fg)) {
    const rgb = [1, 3, 5].map(at => Number.parseInt(style.fg.slice(at, at + 2), 16));
    codes.push(`38;2;${rgb.join(';')}`);
  }
  if (style.b === true) codes.push('1');
  if (style.d === true) codes.push('2');
  if (style.i === true) codes.push('7');
  return codes.length === 0 ? text : `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

/** Leading whole runs; if none fits, clip the first, reserving the cut marker. */
export function fitRuns(runs, room) {
  let used = 0;
  const kept = [];
  for (const run of runs) {
    if (used + run.width > room - 1) break;
    kept.push(run);
    used += run.width;
  }
  // Gap runs at the end are not a useful leading part.
  while (kept.length > 0 && /^\s+$/.test(kept.at(-1).text)) kept.pop();
  if (kept.length === 0 && runs[0]) {
    let text = '';
    let width = 0;
    for (const char of runs[0].text) {
      const next = charWidth(char.codePointAt(0));
      if (width + next > room - 1) break;
      text += char;
      width += next;
    }
    kept.push({ ...runs[0], text, width });
  }
  return [...kept, { text: '~', width: 1, style: {} }];
}

const runsWidth = runs => runs.reduce((sum, run) => sum + run.width, 0);

function runArray(runs, now) {
  if (!Array.isArray(runs)) throw new Error('invalid run array');
  return runs.map(run => runValue(run, now));
}

/** Greedy ordered segments, with a plugin-authored hidden marker on the last line. */
function packLines(pack, room, now) {
  if (!Array.isArray(pack?.items) || pack.items.length === 0 ||
      !Array.isArray(pack.more) || pack.more.length < pack.items.length ||
      !Number.isInteger(pack.maxLines) || pack.maxLines < 1 || pack.maxLines > 4) throw new Error('invalid pack');
  const items = pack.items.map(item => runArray(item, now));
  const sep = runArray(pack.sep, now);
  const more = pack.more.map(marker => runArray(marker, now));
  const sepWidth = runsWidth(sep);
  const join = segments => segments.flatMap((segment, index) => index === 0 ? segment : [...sep, ...segment]);
  const lines = [[]];
  let index = 0;
  let used = 0;
  while (index < items.length) {
    const last = lines.at(-1);
    const width = runsWidth(items[index]);
    if (last.length === 0 || used + sepWidth + width <= room) {
      used += (last.length === 0 ? 0 : sepWidth) + width;
      last.push(items[index++]);
    } else if (lines.length < pack.maxLines) {
      lines.push([]);
      used = 0;
    } else {
      break;
    }
  }
  let hidden = items.length - index;
  if (hidden > 0) {
    const last = lines.at(-1);
    while (last.length > 0 && used + sepWidth + runsWidth(more[hidden - 1]) > room) {
      used -= runsWidth(last.pop()) + (last.length === 0 ? 0 : sepWidth);
      hidden += 1;
    }
    last.push(more[hidden - 1]);
  }
  return lines.map(segments => {
    const runs = join(segments);
    return runsWidth(runs) <= room ? runs : fitRuns(runs, room);
  });
}

/** Widest fitting forms or packed segments, at most four output lines. */
export function renderLines(snapshot, sessionId, columns, now) {
  try {
    if (snapshot?.v !== 1 || snapshot.sessionId !== sessionId ||
        !Number.isFinite(snapshot.updatedAt) || !Number.isFinite(now) || now - snapshot.updatedAt > 120000 ||
        !Array.isArray(snapshot.lines)) return [];
    const value = typeof columns === 'string' && /^\d+$/.test(columns) ? Number(columns) : columns;
    const room = Math.max(1, (Number.isSafeInteger(value) && value > 0 ? value : 120) - 4);
    return snapshot.lines.flatMap(line => {
      if (line !== null && typeof line === 'object' && 'pack' in line) {
        if ('forms' in line) throw new Error('ambiguous line');
        return packLines(line.pack, room, now).map(runs => runs.map(styled).join(''));
      }
      if (!Array.isArray(line?.forms) || line.forms.length === 0) throw new Error('invalid forms');
      const forms = line.forms.map(form => {
        if (!Array.isArray(form)) throw new Error('invalid form');
        return form.map(run => runValue(run, now));
      });
      const fits = forms.find(form => runsWidth(form) <= room);
      return [(fits ?? fitRuns(forms.at(-1), room)).map(styled).join('')];
    }).slice(0, 4);
  } catch {
    return [];
  }
}
