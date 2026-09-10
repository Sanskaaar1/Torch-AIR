import test from 'node:test';
import assert from 'node:assert/strict';
import { isSuccessfulReviewResult, parseReviewCommand, selectReviewHistory } from './gpt-pr-assistant.mjs';

test('recognizes a command only at the beginning of a line and preserves prompt text', () => {
  assert.equal(parseReviewCommand('please @review-agent'), null);
  assert.deepEqual(parseReviewCommand('notes\n@review-agent check parser\nwith context'), { force: false, prompt: 'check parser\nwith context' });
  assert.deepEqual(parseReviewCommand('@review-agent --force check again'), { force: true, prompt: 'check again' });
});

test('deduplication accepts only a successful bot marker for the exact head', () => {
  const comment = { user: { login: 'github-actions[bot]' }, body: '<!-- review-agent: success head_sha=abc -->' };
  assert.equal(isSuccessfulReviewResult(comment, 'abc'), true);
  assert.equal(isSuccessfulReviewResult(comment, 'def'), false);
  assert.equal(isSuccessfulReviewResult({ ...comment, body: '<!-- review-agent: failure -->' }, 'abc'), false);
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
