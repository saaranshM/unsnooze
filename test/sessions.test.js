import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DIR = mkdtempSync(join(tmpdir(), 'unsnooze-sessions-test-'));
process.env.UNSNOOZE_CLAUDE_DIR = join(DIR, 'claude');

const { transcriptPath, approxTokens, lastUsageTokens } = await import('../src/sessions.js');

after(() => rmSync(DIR, { recursive: true, force: true }));

let n = 0;
function fixture(lines) {
  const path = join(DIR, `t${n++}.jsonl`);
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

const usageEntry = (usage, extra = {}) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage }, ...extra });
const noUsageEntry = (text = 'You’ve hit your usage limit') =>
  JSON.stringify({ type: 'user', isApiErrorMessage: true, error: 'rate_limit', message: { content: [{ type: 'text', text }] } });

// input 2000 + cache_creation 2000 + cache_read 148000 + output 500
const USAGE = { input_tokens: 2000, cache_creation_input_tokens: 2000, cache_read_input_tokens: 148_000, output_tokens: 500 };
const USAGE_SUM = 152_500;

test('transcriptPath composes projects/<dashed-cwd>/<id>.jsonl under CLAUDE_DIR', () => {
  const p = transcriptPath('/tmp/proj.x', 'abc-123');
  assert.ok(p.endsWith(join('claude', 'projects', '-tmp-proj-x', 'abc-123.jsonl')), p);
});

test('approxTokens formats thousands with a ~k suffix', () => {
  assert.equal(approxTokens(152_340), '~152k');
  assert.equal(approxTokens(1000), '~1k');
  assert.equal(approxTokens(999), '~999');
});

test('lastUsageTokens sums the four usage fields of the last usage entry', () => {
  const path = fixture([
    usageEntry({ input_tokens: 5, cache_creation_input_tokens: 5, cache_read_input_tokens: 10, output_tokens: 1 }),
    usageEntry(USAGE),
  ]);
  assert.equal(lastUsageTokens(path), USAGE_SUM);
});

test('scans back past trailing entries without usage (the rate-limit tail)', () => {
  const path = fixture([
    usageEntry(USAGE),
    noUsageEntry(),
    noUsageEntry(),
  ]);
  assert.equal(lastUsageTokens(path), USAGE_SUM);
});

test('sidechain entries are skipped even when they carry usage', () => {
  const path = fixture([
    usageEntry(USAGE),
    usageEntry({ input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }, { isSidechain: true }),
  ]);
  assert.equal(lastUsageTokens(path), USAGE_SUM);
});

test('zero-sum usage blocks are skipped (synthetic entries must not defeat the guard)', () => {
  const path = fixture([
    usageEntry(USAGE),
    usageEntry({ input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 }),
  ]);
  assert.equal(lastUsageTokens(path), USAGE_SUM);
});

test('malformed lines are skipped without crashing', () => {
  const path = fixture([
    usageEntry(USAGE),
    '{oops not json',
    'plain text line',
  ]);
  assert.equal(lastUsageTokens(path), USAGE_SUM);
});

test('grows the read window when the tail has no usage entry', () => {
  const pad = noUsageEntry('x'.repeat(300));
  const path = fixture([usageEntry(USAGE), ...Array(20).fill(pad)]);   // ~7KB of tail padding
  assert.equal(lastUsageTokens(path, { window: 1024 }), USAGE_SUM);
});

test('returns null when the last usage entry lies beyond maxWindow', () => {
  const pad = noUsageEntry('x'.repeat(300));
  const path = fixture([usageEntry(USAGE), ...Array(20).fill(pad)]);   // usage ~7KB from the end
  assert.equal(lastUsageTokens(path, { window: 512, maxWindow: 2048 }), null);
});

test('returns null for missing, empty, or usage-less files', () => {
  assert.equal(lastUsageTokens(join(DIR, 'nope.jsonl')), null);
  assert.equal(lastUsageTokens(fixture([''])), null);
  assert.equal(lastUsageTokens(fixture([noUsageEntry()])), null);
});
