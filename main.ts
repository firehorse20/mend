// main.ts is mend, the CLI SPEC.md specifies (MIT). It does sections 1 to 10 of SPEC.md: the command line, the
// output and exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs
// (section 6), SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the
// all-or-nothing write (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Files and lines (SPEC.md section 3) ----

/** A file split at its own line break, with whether it ends with one. */
interface FileModel {
  br: string;
  lines: string[];
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

// ---- Matching lines (SPEC.md section 5) ----

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions at or after `from` where O occurs in `file` at `tier`; occurrences may overlap. */
function occurrencesAt(file: string[], O: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (tierKey(file[i + j]!, tier) !== tierKey(O[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions; null when none. */
function firstTier(file: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(file, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor` at the first tier where one is; null when none. */
function findAnchor(file: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let i = from; i < file.length; i++) {
      if (tierKey(file[i]!, t) === tierKey(anchor, t)) return i;
    }
  }
  return null;
}

function leadWs(s: string): string {
  return /^[ \t]*/.exec(s)![0];
}

/** A tier-2 re-indent of one line of N (SPEC.md section 5). */
function reindent(line: string, firstFileLine: string, firstOLine: string): string {
  if (line === '' || line.trim() === '') return line;
  const f = leadWs(firstFileLine);
  const p = leadWs(firstOLine);
  if (line.startsWith(p)) return f + line.slice(p.length);
  return line;
}

/** Old lines O and new lines N of one hunk, chunk or block, with the context mapping. */
interface Block {
  O: string[];
  N: string[];
  /** N[i] is a context line, written as the file's own matched line. */
  nIsCtx: boolean[];
  /** N[i] -> index in O for a context line, -1 otherwise. */
  nToO: number[];
}

function applyReplace(lines: string[], pos: number, blk: Block, tier: number): string[] {
  const out = [...lines];
  const repl: string[] = [];
  for (let j = 0; j < blk.N.length; j++) {
    if (blk.nIsCtx[j]) repl.push(lines[pos + blk.nToO[j]!]!);
    else if (tier === 2 && blk.O.length > 0) repl.push(reindent(blk.N[j]!, lines[pos]!, blk.O[0]!));
    else repl.push(blk.N[j]!);
  }
  out.splice(pos, blk.O.length, ...repl);
  return out;
}

// ---- Unified diffs (SPEC.md section 6) ----

type BodyKind = 'ctx' | 'old' | 'new' | 'backslash';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}
interface Section {
  oldPath: string | null;
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
  /** A `---`/`+++` pair named the paths; rename lines then do not (SPEC.md section 6). */
  dashPair: boolean;
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a leading a/ or b/ removed. */
function diffPath(s: string): string {
  let p = s.split('\t')[0]!.trim();
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, idx: number): Hunk {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
  return { a: Number(m[1]), body: [] };
}

/** Collect a hunk's body starting at `i`; returns the index after it. */
function collectBody(lines: string[], i: number, hunk: Hunk): number {
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') hunk.body.push({ kind: 'ctx', text: '' });
    else if (l[0] === ' ') hunk.body.push({ kind: 'ctx', text: l.slice(1) });
    else if (l[0] === '-') hunk.body.push({ kind: 'old', text: l.slice(1) });
    else if (l[0] === '+') hunk.body.push({ kind: 'new', text: l.slice(1) });
    else if (l[0] === '\\') hunk.body.push({ kind: 'backslash', text: l });
    else break;
    i++;
  }
  // Empty lines at the end of a body are not part of it.
  while (hunk.body.length > 0) {
    const last = hunk.body[hunk.body.length - 1]!;
    if (last.kind === 'ctx' && last.text === '') hunk.body.pop();
    else break;
  }
  return i;
}

/** Whether a `\` line follows the hunk's last context or `+` line. */
function backslashAfterLastNorPlus(body: BodyLine[]): boolean {
  for (let j = body.length - 1; j >= 0; j--) {
    if (body[j]!.kind === 'ctx' || body[j]!.kind === 'new') {
      const next = body[j + 1];
      return next !== undefined && next.kind === 'backslash';
    }
  }
  return false;
}

function blockOf(body: BodyLine[]): Block {
  const blk: Block = { O: [], N: [], nIsCtx: [], nToO: [] };
  for (const l of body) {
    if (l.kind === 'ctx') {
      blk.O.push(l.text);
      blk.N.push(l.text);
      blk.nIsCtx.push(true);
      blk.nToO.push(blk.O.length - 1);
    } else if (l.kind === 'old') {
      blk.O.push(l.text);
    } else if (l.kind === 'new') {
      blk.N.push(l.text);
      blk.nIsCtx.push(false);
      blk.nToO.push(-1);
    }
  }
  return blk;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunks = false;
  let i = 0;
  const newSection = (oldPath: string | null, newPath: string | null): Section => {
    const s: Section = { oldPath, newPath, create: false, del: false, hunks: [], dashPair: false };
    sections.push(s);
    cur = s;
    inHunks = false;
    return s;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (cur === null) {
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        newSection(null, null);
        continue;
      }
      if (line.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (!inHunks) {
      if (line.startsWith('--- ')) {
        const next = lines[i + 1];
        if (next === undefined || !next.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        cur.oldPath = diffPath(line.slice(4));
        cur.newPath = diffPath(next.slice(4));
        cur.dashPair = true;
        i += 2;
        continue;
      }
      if (line.startsWith('+++ ')) {
        cur.newPath = diffPath(line.slice(4));
        i++;
        continue;
      }
      if (line.startsWith('rename from ')) {
        if (!cur.dashPair) cur.oldPath = line.slice(12).trim();
        i++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        if (!cur.dashPair) cur.newPath = line.slice(10).trim();
        i++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        cur.create = true;
        i++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        cur.del = true;
        i++;
        continue;
      }
      if (line.startsWith('@@')) {
        const h = parseHunkHeader(line, i);
        cur.hunks.push(h);
        inHunks = true;
        i = collectBody(lines, i + 1, h);
        continue;
      }
      i++;
      continue;
    }
    // After the hunks started: a ---/+++ pair starts a new section, @@ a new hunk, the rest is prose.
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      newSection(null, null);
      continue;
    }
    if (line.startsWith('@@')) {
      const h = parseHunkHeader(line, i);
      cur.hunks.push(h);
      i = collectBody(lines, i + 1, h);
      continue;
    }
    i++;
  }
  return sections.map((sec) => unifiedSectionEdit(sec, strict));
}

function unifiedSectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    const oldReal = oldP !== null && oldP !== '/dev/null' ? oldP : null;
    const newReal = newP !== null && newP !== '/dev/null' ? newP : null;
    const isCreate = sec.create || oldP === '/dev/null';
    const isDelete = sec.del || newP === '/dev/null';
    if (isCreate) {
      if (newReal === null) return;
      if (!safe(newReal)) throw new Fail('unsafe', newReal);
      if (tree.get(newReal) !== null) throw new Fail('exists', newReal);
      const plus: string[] = [];
      let final = true;
      let lastPlus: { hunk: Hunk; idx: number } | null = null;
      for (const h of sec.hunks) {
        for (let j = 0; j < h.body.length; j++) {
          if (h.body[j]!.kind === 'new') {
            plus.push(h.body[j]!.text);
            lastPlus = { hunk: h, idx: j };
          }
        }
      }
      if (lastPlus !== null) {
        const next = lastPlus.hunk.body[lastPlus.idx + 1];
        final = !(next !== undefined && next.kind === 'backslash');
      }
      tree.now.set(newReal, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
      return;
    }
    if (isDelete) {
      if (oldReal === null) return;
      if (!safe(oldReal)) throw new Fail('unsafe', oldReal);
      if (tree.get(oldReal) === null) throw new Fail('missing', oldReal);
      tree.now.set(oldReal, null);
      return;
    }
    const from = oldReal ?? newReal;
    const to = newReal ?? oldReal;
    if (from === null || to === null) return;
    if (!safe(from)) throw new Fail('unsafe', from);
    if (from !== to && !safe(to)) throw new Fail('unsafe', to);
    const before = tree.get(from);
    if (before === null) throw new Fail('missing', from);
    if (from !== to && tree.get(to) !== null) throw new Fail('exists', to);
    let f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const blk = blockOf(h.body);
      if (blk.O.length === 0) {
        let at = h.a + d;
        if (at < 0) at = 0;
        if (at > f.lines.length) at = f.lines.length;
        const atEnd = at === f.lines.length;
        const nl = [...f.lines];
        nl.splice(at, 0, ...blk.N);
        f = { ...f, lines: nl, final: atEnd ? !backslashAfterLastNorPlus(h.body) : f.final };
        d += blk.N.length;
      } else {
        const found = firstTier(f.lines, blk.O, 0, strict);
        if (found === null) throw new Fail('no-match', from);
        const target = h.a - 1 + d;
        let best = found.occ[0]!;
        for (const p of found.occ) {
          if (Math.abs(p - target) < Math.abs(best - target)) best = p;
        }
        const atEnd = best + blk.O.length === f.lines.length;
        const nl = applyReplace(f.lines, best, blk, found.tier);
        f = { ...f, lines: nl, final: atEnd ? !backslashAfterLastNorPlus(h.body) : f.final };
        d += blk.N.length - blk.O.length;
      }
    }
    const out = joinFile(f);
    if (from !== to) {
      tree.now.set(to, out);
      tree.now.set(from, null);
      tree.moves.push([from, to]);
    } else {
      tree.now.set(from, out);
    }
  };
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = searchIdx + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const found = firstTier(f.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const blk: Block = { O: oldLines, N: newLines, nIsCtx: newLines.map(() => false), nToO: newLines.map(() => -1) };
    const nl = applyReplace(f.lines, found.occ[0]!, blk, found.tier);
    tree.now.set(path, joinFile({ ...f, lines: nl }));
  };
}

// ---- V4A patches (SPEC.md section 8) ----

interface VChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  const last = (() => {
    for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) return k;
    return -1;
  })();
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const body: { idx: number; line: string }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        body.push({ idx: j, line: lines[j]! });
        j++;
      }
      while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
      const fileLines: string[] = [];
      for (const b of body) {
        if (b.line.startsWith('+')) fileLines.push(b.line.slice(1));
        else if (blank(b.line)) fileLines.push('');
        else throw new Exit2(`error: parse ${b.idx + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      const body: { idx: number; line: string }[] = [];
      let j = i + 1;
      while (j < last && !isSectionStart(lines[j]!)) {
        body.push({ idx: j, line: lines[j]! });
        j++;
      }
      while (body.length > 0 && blank(body[body.length - 1]!.line)) body.pop();
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.idx + 1}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      let j = i + 1;
      let moveTo: string | null = null;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      const finish = (): void => {
        if (cur === null) return;
        while (cur.body.length > 0) {
          const b = cur.body[cur.body.length - 1]!;
          if (b.kind === 'ctx' && b.text === '') cur.body.pop();
          else break;
        }
        chunks.push(cur);
        cur = null;
      };
      while (j < last) {
        const l = lines[j]!;
        if (isSectionStart(l)) break;
        if (l.startsWith('@@')) {
          finish();
          cur = { anchor: l.slice(2).trim(), body: [], eof: false };
          j++;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          finish();
          j++;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
            cur = { anchor: null, body: [], eof: false };
          }
          if (l === '') cur.body.push({ kind: 'ctx', text: '' });
          else if (l[0] === ' ') cur.body.push({ kind: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.body.push({ kind: 'old', text: l.slice(1) });
          else cur.body.push({ kind: 'new', text: l.slice(1) });
          j++;
          continue;
        }
        if (blank(l)) {
          // A whitespace-only line that starts with no marker: an empty context line inside a chunk.
          if (cur !== null) cur.body.push({ kind: 'ctx', text: '' });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      finish();
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(t);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const blk = blockOf(ch.body);
      if (blk.O.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const nl = [...f.lines];
        nl.splice(at, 0, ...blk.N);
        f = { ...f, lines: nl };
        cursor = at + blk.N.length;
      } else {
        const found = firstTier(f.lines, blk.O, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let pos: number;
        if (ch.eof) {
          const ends = found.occ.filter((p) => p + blk.O.length === f.lines.length);
          if (ends.length === 0) throw new Fail('no-match', path);
          pos = ends[0]!;
        } else {
          pos = found.occ[0]!;
        }
        const nl = applyReplace(f.lines, pos, blk, found.tier);
        f = { ...f, lines: nl };
        cursor = pos + blk.N.length;
      }
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [oldP, newP] of tree.moves) {
    const dIdx = changed.findIndex((c) => c.line === `D ${oldP}`);
    const aIdx = changed.findIndex((c) => c.line === `A ${newP}`);
    if (dIdx >= 0 && aIdx >= 0) {
      changed.splice(Math.max(dIdx, aIdx), 1);
      changed.splice(Math.min(dIdx, aIdx), 1);
      changed.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  changed.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = changed.map((c) => c.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
