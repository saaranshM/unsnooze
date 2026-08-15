// Claude Code's real banner and error strings, extracted verbatim from the
// shipped 2.1.233 binary (`strings` over the bundle) and cross-checked against
// code.claude.com/docs/en/errors on 2026-08-16.
//
// Written while looking for Claude Design-specific limit banners for issue #13.
// There are none — Design draws from the shared pool, so a design session that
// runs out shows the ordinary banner below. What Design does have is its own
// AUTH failures, which are stops that waiting can never clear.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectLimit, overloadMatch } from '../src/patterns.js';
import { patterns } from '../src/agents/claude.js';

const detect = text => detectLimit(text, 12, patterns);

// --- the ordinary limit banners (these must keep working) ------------------

test('every current limit banner variant is still detected', () => {
  const banners = [
    ["You've hit your session limit · resets 3:45pm", '5h'],
    ["You've hit your weekly limit · resets Mon 12:00am", 'weekly'],
    ["You've hit your Opus limit · resets 3:45pm", null],
    // Variants found in the 2.1.233 bundle that predate this test.
    ["You've hit your fast limit · resets 3:45pm", null],
    ["You've hit your monthly limit · resets Sep 1 at 12:00am", null],
    ["You've hit your limit · resets 3:45pm", null],
  ];
  for (const [text, expectedType] of banners) {
    const d = detect(text);
    assert.equal(d.hit, true, `not detected: ${text}`);
    if (expectedType) assert.equal(d.limitType, expectedType, `wrong type for: ${text}`);
  }
});

test('a design session hitting the shared limit is an ordinary stop', () => {
  // The whole reason there are no Design-specific limit patterns: Design has
  // no separate allowance and no separate banner.
  const d = detect("⚠ You've hit your session limit\n· resets 6:40pm (Asia/Calcutta)");
  assert.equal(d.hit, true);
  assert.equal(d.limitType, '5h');
});

// --- the server throttle that says it is not a usage limit -----------------

test('a server-side throttle is never recorded as a usage limit', () => {
  // Verbatim from the bundle. `/usage limit/i` matches the parenthetical, so
  // with any stale "resets 3pm" still in the pane tail this recorded an
  // hours-long wait for a throttle that clears in seconds — and it says so
  // itself, right there in the message.
  const throttle = 'API Error: Server is temporarily limiting requests (not your usage limit)';
  assert.equal(detect(throttle).hit, false);
  assert.equal(detect(`${throttle}\n· resets 3pm`).hit, false,
    'a nearby reset line must not turn a disclaimed throttle into a limit');
  assert.equal(detect(`❯ ${throttle}\n· resets 3pm (UTC)`).hit, false);
});

test('the throttle is still handled — as an overload, on the retry ladder', () => {
  const throttle = 'API Error: Server is temporarily limiting requests (not your usage limit)';
  assert.ok(overloadMatch(throttle, patterns.overloadPatterns),
    'a transient server throttle belongs on the seconds-scale ladder, not the ledger');
});

test('the disclaimer guard does not swallow a real limit', () => {
  // The guard keys on "not your … limit". A genuine banner never says that.
  assert.equal(detect("You've hit your session limit · resets 3:45pm").hit, true);
  assert.equal(detect("You've hit your weekly limit · resets Mon 12:00am").hit, true);
});

// --- non-resetting stops (terminalPatterns) --------------------------------

test('Claude Design auth failures are terminal, not something to wait out', () => {
  // Verbatim from the bundle. An expired design credential is not a usage
  // limit: no amount of waiting clears it, so it must never enter the ledger
  // as a stop with a reset time.
  const authFailures = [
    'Claude Design rejected your /design-login credential (HTTP 403). Run /design-login to re-authorize it.',
    'Could not refresh the design access token (transient error). Retry shortly, or run /design-login to re-authorize.',
    'Claude Design needs a claude.ai credential, but /design-login requires an interactive terminal and is not available in this environment.',
    'DesignSync needs design-system authorization, but /design-login requires an interactive terminal and is not available in this environment.',
    'Could not save the design credential to secure storage. Retry, or run /design-login.',
  ];
  for (const text of authFailures) {
    assert.ok(patterns.terminalPatterns.some(p => p.test(text)),
      `design auth failure not classified as terminal: ${text}`);
    assert.equal(detect(text).hit, false, `must not be a limit stop: ${text}`);
  }
});

test('the headless case is covered — the one an overnight run actually hits', () => {
  // A revived headless session has no interactive terminal, so an expired
  // credential produces exactly this and can never self-resolve. Resuming it
  // on a timer would loop until the attempt cap.
  const text = 'Claude Design needs a claude.ai credential, but /design-login '
    + 'requires an interactive terminal and is not available in this environment.';
  assert.ok(patterns.terminalPatterns.some(p => p.test(text)));
});

test('an exhausted credit balance is terminal too', () => {
  for (const text of ['Credit balance is too low', 'credit balance is too low']) {
    assert.ok(patterns.terminalPatterns.some(p => p.test(text)), text);
  }
});

test('an agent merely mentioning /design-login is not a terminal stop', () => {
  // terminalPatterns notify once and never record, so a false positive is
  // cheap — but it still puts a wrong notification in front of the user.
  // Anchored to the real error phrasings, not to the bare command name.
  const prose = [
    'You can run /design-login to sign in to Claude Design.',
    'If Design is signed out, the fix is `/design-login`.',
    'I will now call the claude-design MCP server.',
  ];
  for (const text of prose) {
    assert.ok(!patterns.terminalPatterns.some(p => p.test(text)),
      `prose wrongly classified as a terminal stop: ${text}`);
  }
});
