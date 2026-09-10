import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewInput, buildReviewableDiff, extractResponseText, formatDeduplicationComment, isAllowedGithubApiUrl, isCompletedResponse, isSuccessfulReviewResult, parseReviewCommand, redactSensitiveText, sanitizeReviewOutput, selectReviewHistory, shouldRetryForOutputLimit } from './review-agent.mjs';

const rawRestSuccess = {
  status: 'completed',
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: '{"summary":"No blocking issues found.","findings":[]}' }],
  }],
};

const multipleAssistantTextParts = {
  status: 'completed',
  output: [
    { type: 'reasoning', summary: [] },
    { type: 'message', content: [{ type: 'output_text', text: '## Finding\nUse a bound.' }, { type: 'refusal', refusal: null }] },
    { type: 'function_call', name: 'ignored' },
    { type: 'message', content: [{ type: 'output_text', text: '## Summary\nTests needed.' }] },
  ],
};

const sdkStyleSuccess = {
  status: 'completed',
  output_text: 'SDK convenience text',
  output: [{ type: 'message', content: [{ type: 'output_text', text: 'Raw fallback text' }] }],
};

test('recognizes a command as the first non-whitespace content on a line and preserves prompt text', () => {
  assert.equal(parseReviewCommand('please @review-agent'), null);
  assert.deepEqual(parseReviewCommand('notes\n@review-agent check parser\nwith context'), { force: false, prompt: 'check parser\nwith context' });
  assert.deepEqual(parseReviewCommand('  @review-agent check indented command'), { force: false, prompt: 'check indented command' });
  assert.deepEqual(parseReviewCommand('@review-agent --force check again'), { force: true, prompt: 'check again' });
});

test('deduplication accepts only a successful bot marker for the exact head', () => {
  const comment = { user: { login: 'github-actions[bot]' }, body: '<!-- review-agent: success head_sha=abc -->' };
  assert.equal(isSuccessfulReviewResult(comment, 'abc'), true);
  assert.equal(isSuccessfulReviewResult(comment, 'def'), false);
  assert.equal(isSuccessfulReviewResult({ ...comment, body: '<!-- review-agent: failure -->' }, 'abc'), false);
  assert.equal(isSuccessfulReviewResult({ ...comment, body: '<!-- review-agent: success head_sha=abc attempt=force -->' }, 'abc'), true);
  assert.equal(formatDeduplicationComment('abc'), 'No changes have been made since the previous successful review of this PR head, so no new review was run.\n\n<!-- review-agent: skipped head_sha=abc -->');
});

test('extracts raw REST Markdown output and produces the normal success-marker body', () => {
  const response = { ...rawRestSuccess, output: [{ type: 'message', content: [{ type: 'output_text', text: '## General Review\n\nNo blocking issues found.' }] }] };
  const review = sanitizeReviewOutput(extractResponseText(response));
  assert.equal(review, '## General Review\n\nNo blocking issues found.');
  assert.equal(rawRestSuccess.status, 'completed');
  assert.equal(`${review}\n\n<!-- review-agent: success head_sha=abc123 -->`, '## General Review\n\nNo blocking issues found.\n\n<!-- review-agent: success head_sha=abc123 -->');
});

test('extracts multiple assistant output text parts in API order and ignores non-text output', () => {
  assert.equal(extractResponseText(multipleAssistantTextParts), '## Finding\nUse a bound.\n## Summary\nTests needed.');
});

test('prefers the SDK output_text convenience field when it is non-empty', () => {
  assert.equal(extractResponseText(sdkStyleSuccess), 'SDK convenience text');
  assert.equal(extractResponseText({ ...sdkStyleSuccess, output_text: '  ' }), 'Raw fallback text');
});

test('does not treat missing text or non-completed responses as successful reviews', () => {
  assert.equal(extractResponseText({ status: 'completed', output: [] }), '');
  const incomplete = { status: 'incomplete', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Partial review' }] }] };
  assert.equal(extractResponseText(incomplete), 'Partial review');
  assert.equal(isCompletedResponse({ status: 'completed' }), true);
  for (const status of ['failed', 'cancelled', 'incomplete']) {
    assert.equal(isCompletedResponse({ status }), false);
  }
});

test('keeps reviewable source patches and excludes lockfiles, generated files, and media', () => {
  const diff = buildReviewableDiff([
    { filename: 'src/app.js', patch: '@@ -1 +1 @@\n-old\n+new' },
    { filename: 'package-lock.json', patch: '@@ -1 +1 @@\n-lock' },
    { filename: 'dist/bundle.js', patch: '@@ -1 +1 @@\n-minified' },
    { filename: 'assets/logo.svg', patch: '@@ -1 +1 @@\n-svg' },
  ]);
  assert.match(diff, /src\/app\.js/);
  assert.doesNotMatch(diff, /package-lock|dist\/bundle|logo\.svg/);
});

test('bounds review input while retaining the architecture checklist and review history ahead of a large diff', () => {
  const result = buildReviewInput({
    commandPrompt: 'check this', pr: { number: 7, title: 'Title', body: '' }, headSha: 'abc',
    files: [{ filename: 'src/app.js', additions: 1, deletions: 1 }], diff: 'd'.repeat(100_000),
    history: [{ kind: 'inline', botFinding: false, trusted: true, createdAt: '', author: 'owner', path: 'src/app.js', line: 1, body: 'prior finding' }],
    checklist: 'architecture requirement', architectureApplies: true,
  });
  assert.ok(result.input.length <= 64_000);
  assert.match(result.input, /architecture requirement/);
  assert.match(result.input, /prior finding/);
  assert.match(result.input, /\[truncated\]/);
  assert.equal(result.truncated, true);
});

test('retries only responses that exhausted their output-token limit', () => {
  assert.equal(shouldRetryForOutputLimit({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }), true);
  assert.equal(shouldRetryForOutputLimit({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } }), false);
  assert.equal(shouldRetryForOutputLimit({ status: 'completed' }), false);
});

test('redacts high-confidence secrets before model submission', () => {
  const value = 'token ghp_abcdefghijklmnopqrstuvwxyz1234567890 and sk-proj-abcdefghijklmnopqrstuvwxyz1234567890\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----';
  const result = redactSensitiveText(value);
  assert.equal(result.count, 3);
  assert.equal(result.text.includes('ghp_'), false);
  assert.equal(result.text.includes('sk-proj-'), false);
  assert.equal(result.text.includes('BEGIN PRIVATE KEY'), false);
});

test('neutralizes model mentions and images and rejects oversized output', () => {
  assert.equal(sanitizeReviewOutput('@maintainer ![tracking](https://example.test/pixel.png)'), '@\u200Bmaintainer [external image omitted]');
  assert.throws(() => sanitizeReviewOutput('x'.repeat(20_001)), /safe output limit/);
});

test('allows only HTTPS URLs on the configured GitHub API origin', () => {
  assert.equal(isAllowedGithubApiUrl('https://api.github.com/repos/a/b'), true);
  assert.equal(isAllowedGithubApiUrl('https://attacker.example/repos/a/b'), false);
  assert.equal(isAllowedGithubApiUrl('http://api.github.com/repos/a/b'), false);
});

test('history prefers trusted relevant recent feedback and removes duplicates', () => {
  const result = selectReviewHistory({ changedFiles: ['x.js'], issueComments: [
    { id: 1, body: 'same issue', user: { login: 'member' }, author_association: 'MEMBER', created_at: '2026-01-01T00:00:00Z' },
    { id: 2, body: 'same issue', user: { login: 'member' }, author_association: 'MEMBER', created_at: '2026-01-02T00:00:00Z' },
  ], reviewComments: [{ id: 3, body: 'line issue', path: 'x.js', line: 8, user: { login: 'owner' }, author_association: 'OWNER', created_at: '2026-01-01T00:00:00Z' }] });
  assert.equal(result.considered, 2);
  assert.equal(result.included[0].body, 'line issue');
});

test('history retains prior successful bot findings only as lower-priority context', () => {
  const result = selectReviewHistory({ changedFiles: [], issueComments: [
    { id: 1, body: '<!-- review-agent: success head_sha=abc -->\nold finding', user: { login: 'github-actions[bot]' }, created_at: '2026-01-02T00:00:00Z' },
  ] });
  assert.equal(result.included[0].botFinding, true);
});
