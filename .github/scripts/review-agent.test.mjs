import test from 'node:test';
import assert from 'node:assert/strict';
import { extractResponseText, formatDeduplicationComment, isCompletedResponse, isSuccessfulReviewResult, parseReviewCommand, selectReviewHistory } from './review-agent.mjs';

const rawRestSuccess = {
  status: 'completed',
  output: [{
    type: 'message',
    content: [{ type: 'output_text', text: '## Review\n\nNo blocking issues found.' }],
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
  assert.equal(formatDeduplicationComment('abc'), 'No changes have been made since the previous successful review of this PR head, so no new review was run.\n\n<!-- review-agent: skipped head_sha=abc -->');
});

test('extracts raw REST output text and produces the normal success-marker body', () => {
  const review = extractResponseText(rawRestSuccess);
  assert.equal(review, '## Review\n\nNo blocking issues found.');
  assert.equal(rawRestSuccess.status, 'completed');
  assert.equal(`${review}\n\n<!-- review-agent: success head_sha=abc123 -->`, '## Review\n\nNo blocking issues found.\n\n<!-- review-agent: success head_sha=abc123 -->');
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
