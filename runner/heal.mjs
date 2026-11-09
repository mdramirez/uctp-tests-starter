// Self-healing (Charter360 roadmap items 22-26, 2026-11-07).
//   US-026  failureKind(): every failed, flaky or blocked test says WHY: not found, more than one match,
//           timeout, wrong result, environment, or other.
//   US-027  healOf(): a test that passed only through a backup locator (helpers/web.ts heal()) is "Healed",
//           never "Passed", with the old and the new locator.
//   US-028  repairCheck(): a proposed repair may change LOCATORS only. Expected values, test data, steps and the
//           title stay exactly as written; anything else is refused with "Repairs may change locators only".
//   US-029  healMessage(): the commit message for an accepted heal, "Heal W1: old → new".
// Nothing here runs a command or touches the network.

export const KIND_LABEL = {
  not_found: 'Not found',
  multiple: 'More than one match',
  timeout: 'Timeout',
  assertion: 'Wrong result',
  environment: 'Environment',
  other: 'Other',
};
// The kinds a locator repair can fix (US-028). A wrong result is a finding, never a repair.
export const REPAIRABLE = new Set(['not_found', 'multiple']);

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const clean = s => String(s ?? '').replace(ANSI, '');
const short = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 300);

// US-026: sort one error message. Returns { kind, locator } (locator '' when none is named).
export function failureKind(message) {
  const m = clean(message);
  if (!m.trim()) return { kind: 'other', locator: '' };
  const locatorLine = (/^\s*Locator:\s*(.+)$/m.exec(m) || [])[1] || '';
  // The site, the network or the browser, not the test.
  if (/net::ERR_|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNRESET|socket hang up|browserType\.launch|Executable doesn't exist|Browser has been closed|Target page, context or browser has been closed|\b(page|frame)\.goto: Timeout/.test(m)
      || /\b(502|503|504) (Bad Gateway|Service Unavailable|Gateway Time-?out)\b/i.test(m)) {
    return { kind: 'environment', locator: '' };
  }
  const strict = /strict mode violation: (.+?) resolved to (\d+) elements/.exec(m);
  if (strict) return { kind: 'multiple', locator: short(strict[1]) };
  if (/element\(s\) not found/.test(m)) return { kind: 'not_found', locator: short(locatorLine) };
  // An action that waited for its element and never found it ("waiting for getByText('x')" and nothing resolved).
  const waited = /\.\w+: (?:Test )?[Tt]imeout \d+ms exceeded[\s\S]*?waiting for (.+)/.exec(m);
  if (waited && !/locator resolved to|resolved to \d+ element/.test(m)) {
    return { kind: 'not_found', locator: short(waited[1].replace(/\s+to be (visible|attached|enabled|editable|stable).*$/, '')) };
  }
  if (/\bexpect\(.*?\)\.(not\.)?to\w+\(|^\s*Expected[^\n]*:|^\s*Received[^\n]*:|^\s*expected .+\n\s*got /m.test(m)) {
    return { kind: 'assertion', locator: short(locatorLine) };
  }
  if (/Test timeout of \d+ms exceeded|Timeout \d+ms exceeded/.test(m)) return { kind: 'timeout', locator: short(locatorLine) };
  return { kind: 'other', locator: '' };
}

// "More than one match: getByText('Your name')" (the line Charter360 shows in a node's note and the report).
export function kindText(kind, locator) {
  const label = KIND_LABEL[kind] || KIND_LABEL.other;
  return locator ? `${label}: ${locator}` : label;
}

// US-027: the backup locator a passing attempt used, from helpers/web.ts heal() (an annotation of type "healed",
// description = JSON {from, to}). null when the test passed with its own locators.
export function healOf(annotations) {
  for (const a of Array.isArray(annotations) ? annotations : []) {
    if (!a || a.type !== 'healed' || typeof a.description !== 'string') continue;
    try {
      const d = JSON.parse(a.description);
      if (d && typeof d.from === 'string' && typeof d.to === 'string') return { from: short(d.from), to: short(d.to) };
    } catch { /* not ours */ }
  }
  return null;
}

// AC-4: a test that healed in each of the last 3 runs it was in (any browser) keeps healing.
export const KEEPS_HEALING = 'Keeps healing: update the locator or check the page';
export function keepsHealing(id, earlierSummaries, n = 3) {
  const runs = earlierSummaries.filter(s => (s.results || []).some(r => r.id === id)).slice(0, n);
  return runs.length === n && runs.every(s => s.results.some(r => r.id === id && r.status === 'healed'));
}

// ---------- the test block of one id inside a spec file ----------
const START_RE = id => new RegExp(`^[ \\t]*test(?:\\.(?:fixme|skip|only|fail))?\\(\\s*(['"\`])${id}\\s*·`, 'm');
const ANY_START_RE = /^[ \t]*(?:test(?:\.(?:fixme|skip|only|fail|describe))?|describe)\(/m;

// { before, block, after } with before + block + after === text, or null when the id isn't in the file.
export function testBlock(text, id) {
  const s = START_RE(id).exec(text);
  if (!s) return null;
  const rest = text.slice(s.index + s[0].length);
  const next = ANY_START_RE.exec(rest);
  const end = next ? s.index + s[0].length + next.index : text.length;
  return { before: text.slice(0, s.index), block: text.slice(s.index, end), after: text.slice(end) };
}

// ---------- locators ----------
const LOC_METHODS = 'getByRole|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle|getByTestId|locator|filter|first|last|nth|and|or|frameLocator|contentFrame';
const LOC_CALL_RE = new RegExp(`\\.(?:${LOC_METHODS})\\(`, 'g');

// The end of a call whose "(" is at i: the index after its ")", skipping strings and nested brackets.
function closeParen(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === "'" || c === '"' || c === '`') {
      for (j++; j < s.length && s[j] !== c; j++) if (s[j] === '\\') j++;
      continue;
    }
    if (c === '/' && s[j + 1] === '/') { while (j < s.length && s[j] !== '\n') j++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return j + 1; }
  }
  return s.length;
}

// The code with every locator call (.getByRole(…), .locator(…), .first() …) replaced by ".⟨L⟩", whitespace
// squeezed: two blocks that differ only in locators come out the same.
export function withoutLocators(code) {
  let out = '';
  let i = 0;
  LOC_CALL_RE.lastIndex = 0;
  for (let m; (m = LOC_CALL_RE.exec(code));) {
    const end = closeParen(code, m.index + m[0].length - 1);
    out += code.slice(i, m.index) + '.⟨L⟩';
    i = end;
    LOC_CALL_RE.lastIndex = end;
  }
  out += code.slice(i);
  return out.replace(/(\.⟨L⟩)+/g, '.⟨L⟩').replace(/\s+/g, ' ').trim();
}

// Each locator chain in the code, as written: "page.getByText('Your name')" -> "getByText('Your name')".
export function locatorChains(code) {
  const chains = [];
  LOC_CALL_RE.lastIndex = 0;
  for (let m; (m = LOC_CALL_RE.exec(code));) {
    let start = m.index + 1;
    let end = closeParen(code, m.index + m[0].length - 1);
    // keep chaining: .getByRole(…).getByLabel(…).first()
    for (;;) {
      const next = new RegExp(`^\\s*\\.(?:${LOC_METHODS})\\(`).exec(code.slice(end));
      if (!next) break;
      end = closeParen(code, end + next[0].length - 1);
    }
    chains.push(code.slice(start, end).replace(/\s+/g, ' '));
    LOC_CALL_RE.lastIndex = end;
  }
  return chains;
}

// Old and new locator of a repair, for the report and the commit message.
export function locatorChange(oldBlock, newBlock) {
  // Counted, so a locator that was already used once and is now used twice still shows as the new one.
  const count = list => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const minus = (x, y) => [...x].filter(([k, n]) => n > (y.get(k) || 0)).map(([k]) => k);
  const a = count(locatorChains(oldBlock)), b = count(locatorChains(newBlock));
  const from = minus(a, b), to = minus(b, a);
  return { from: short(from.join(', ')), to: short(to.join(', ')) };
}

// ---------- US-028: is this repair allowed? ----------
// { ok: true, from, to } or { ok: false, error } (error starts with "Repairs may change locators only").
export function repairCheck(oldText, newText, id) {
  const ONLY = 'Repairs may change locators only';
  if (typeof newText !== 'string' || !newText.trim()) return { ok: false, error: `${ONLY}: the repair is empty.` };
  const a = testBlock(oldText, id), b = testBlock(newText, id);
  if (!a) return { ok: false, error: `${id} is not in this file.` };
  if (!b) return { ok: false, error: `${ONLY}: the test ${id} and its title must stay.` };
  if (a.before !== b.before || a.after !== b.after) return { ok: false, error: `${ONLY}: nothing outside ${id} may change.` };
  if (a.block === b.block) return { ok: false, error: 'The repair changes nothing.' };
  const x = withoutLocators(a.block), y = withoutLocators(b.block);
  if (x !== y) {
    // Point at the first place that differs (expected value, data, step or title).
    let i = 0;
    while (i < x.length && x[i] === y[i]) i++;
    const near = y.slice(Math.max(0, i - 30), i + 50).replace(/⟨L⟩/g, '…');
    return { ok: false, error: `${ONLY}. Expected values, test data, steps and the title stay as written. It changed near: ${near}` };
  }
  // The thing an expect() looks at is part of the expectation: expect(page.getByText('Saved')).toBeVisible()
  // checks the text "Saved". Every text in an expect() target must still be there after the repair.
  const kept = new Set(expectTargets(b.block).flatMap(stringsIn));
  const lost = expectTargets(a.block).flatMap(stringsIn).filter(s => !kept.has(s));
  if (lost.length) return { ok: false, error: `${ONLY}: the text an expect() checks must stay (${short(lost.map(s => `'${s}'`).join(', '))}).` };
  return { ok: true, ...locatorChange(a.block, b.block) };
}

// The targets of expect(…) calls in the code, as written.
function expectTargets(code) {
  const out = [];
  const re = /\bexpect(?:\.soft|\.poll)?\(/g;
  for (let m; (m = re.exec(code));) {
    const end = closeParen(code, m.index + m[0].length - 1);
    out.push(code.slice(m.index + m[0].length, end - 1));
    re.lastIndex = m.index + m[0].length;
  }
  return out;
}
function stringsIn(code) {
  return [...String(code).matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)].map(m => m[2]);
}

export function healMessage(id, from, to) {
  return `Heal ${id}: ${from || 'locator'} → ${to || 'new locator'}`.slice(0, 300);
}

// ---------- a small line diff (longest common subsequence) for the review dialog ----------
export function lineDiff(oldText, newText) {
  const a = String(oldText).replace(/\n$/, '').split('\n'), b = String(newText).replace(/\n$/, '').split('\n');
  const n = a.length, m = b.length;
  if (n * m > 4e6) return [...a.map(t => ({ op: '-', text: t })), ...b.map(t => ({ op: '+', text: t }))];
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < n) out.push({ op: '-', text: a[i++] });
  while (j < m) out.push({ op: '+', text: b[j++] });
  return out;
}

// ---------- US-027 without AI: put the backup that worked in place of the written locator ----------
// Only when the written locator appears in the test exactly as Playwright printed it. null otherwise.
export function backupFix(text, id, from, to) {
  const t = testBlock(text, id);
  if (!t || !from || !to || from === to) return null;
  const at = t.block.indexOf(from);
  if (at < 0 || t.block.indexOf(from, at + 1) >= 0) return null;           // not there, or more than once: ask the AI
  const block = t.block.slice(0, at) + to + t.block.slice(at + from.length);
  const next = t.before + block + t.after;
  return repairCheck(text, next, id).ok ? next : null;
}

// ---------- US-028: the prompt for the learner's own AI, and reading its answer ----------
export const REPAIR_SYSTEM = [
  'You repair Playwright locators in one test. You change LOCATORS only: getByRole, getByLabel, getByText, getByTestId,',
  'getByPlaceholder, locator, filter, first, last, nth. You never change an expected value, a status code, a message,',
  'test data, the steps, the test title or anything outside this test. Prefer getByRole with a name, then getByLabel,',
  'then getByTestId, then getByText, scoped to the region (dialog, form, row) the test is about.',
  'If the page snapshot shows the app itself changed or is broken (the element, text or value is really gone or',
  'wrong), do not repair: answer exactly "NO_REPAIR: " and one sentence why. That is a finding for the tester.',
  'Otherwise answer with only the whole corrected test in one ```ts code block, nothing else.',
].join(' ');

export function repairPrompt({ id, block, error, kind, locator, aria, heal }) {
  return [
    `Test ${id} failed: ${kindText(kind, locator)}.`,
    heal ? `A backup locator worked in this run: ${heal.from} → ${heal.to}.` : '',
    '', 'The error:', '```', String(error || '').slice(0, 2000), '```',
    '', 'The test:', '```ts', block.replace(/\n$/, ''), '```',
    aria ? ['', 'The page at the failure (accessibility snapshot):', '```yaml', String(aria).slice(0, 12000), '```'].join('\n') : '',
    '', 'Answer with the whole corrected test only, or NO_REPAIR: <why>.',
  ].filter(s => s !== '').join('\n');
}

// The AI's answer -> { block } or { no_repair } or { error }.
export function parseRepair(answer) {
  const s = String(answer || '').trim();
  const no = /^NO_REPAIR:\s*(.+)/is.exec(s);
  if (no) return { no_repair: short(no[1]) };
  const fence = /```(?:ts|typescript|js|javascript)?\s*\n([\s\S]*?)\n?```/.exec(s);
  const code = fence ? fence[1] : (/^\s*test(\.\w+)?\(/.test(s) ? s : '');
  if (!code.trim()) return { error: 'Your AI did not send back a test. Try again, or fix the locator yourself.' };
  return { block: code.replace(/\s+$/, '') };
}

// Put the AI's corrected block back in the file, keeping the file's own spacing after the test.
export function withBlock(text, id, newBlock) {
  const t = testBlock(text, id);
  if (!t) return null;
  const tail = (/\s*$/.exec(t.block) || [''])[0];
  return t.before + newBlock.replace(/\s+$/, '') + tail + t.after;
}
