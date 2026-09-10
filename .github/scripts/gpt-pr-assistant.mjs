#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const HISTORY_MAX_ITEMS = 30;
const HISTORY_MAX_CHARS = 24_000;
const DIFF_MAX_CHARS = 120_000;
const BOT_MARKER = '<!-- review-agent: success head_sha=';

export function parseReviewCommand(body = '') {
  const match = /(?:^|\r?\n)@review-agent(?=$|[ \t])(?:[ \t]*(.*))?/.exec(body);
  if (!match) return null;
  const commandEnd = match.index + match[0].length;
  const firstLinePrompt = match[1] ?? '';
  const remainder = body.slice(commandEnd);
  const prompt = `${firstLinePrompt}${remainder}`.trim();
  const force = /(?:^|\s)--force(?=$|\s)/.test(prompt);
  return { force, prompt: prompt.replace(/(?:^|\s)--force(?=$|\s)/g, ' ').trim() };
}

export function isSuccessfulReviewResult(comment, headSha) {
  return comment?.user?.login === 'github-actions[bot]' &&
    comment.body?.includes(`${BOT_MARKER}${headSha} -->`);
}

function truncate(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function itemFromComment(comment, kind, changedPaths) {
  const body = String(comment.body ?? '');
  const isReviewAgentBot = comment.user?.login === 'github-actions[bot]' && body.includes(BOT_MARKER);
  const quotedFullDiff = /(?:^|\n)>? ?diff --git |(?:^|\n)```diff/.test(body);
  if (!body || (!isReviewAgentBot && quotedFullDiff)) return null;
  const path = comment.path ?? null;
  const line = comment.line ?? comment.original_line ?? null;
  const trusted = TRUSTED.has(comment.author_association);
  return {
    id: `${kind}:${comment.id ?? ''}`, kind, author: comment.user?.login ?? 'unknown',
    trusted, botFinding: isReviewAgentBot, createdAt: comment.updated_at ?? comment.created_at ?? '', path, line,
    relevant: Boolean(path && changedPaths.has(path)),
    unresolved: comment.resolved === false || comment.state === 'CHANGES_REQUESTED',
    body: truncate(body, 1_500),
  };
}

export function selectReviewHistory({ reviewComments = [], issueComments = [], reviews = [], changedFiles = [] }) {
  const changedPaths = new Set(changedFiles.map((file) => typeof file === 'string' ? file : file.filename));
  const candidates = [
    ...reviewComments.map((comment) => itemFromComment(comment, 'inline', changedPaths)),
    ...issueComments.map((comment) => itemFromComment(comment, 'conversation', changedPaths)),
    ...reviews.map((review) => itemFromComment(review, 'review', changedPaths)),
  ].filter(Boolean);
  const seen = new Set();
  const unique = candidates.filter((item) => {
    const key = `${item.author}\0${item.path ?? ''}\0${item.line ?? ''}\0${item.body}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  unique.sort((a, b) => {
    // Trusted human feedback comes first. Bot findings are retained only as
    // lower-priority context for checking whether a previous finding remains.
    const score = (x) => (x.trusted ? 8 : 0) + (x.unresolved ? 4 : 0) + (x.relevant ? 2 : 0) + (x.botFinding ? 1 : 0);
    return score(b) - score(a) || String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const selected = [];
  let chars = 0;
  for (const item of unique) {
    const cost = item.body.length + 220;
    if (selected.length >= HISTORY_MAX_ITEMS || chars + cost > HISTORY_MAX_CHARS) continue;
    selected.push(item); chars += cost;
  }
  return { considered: unique.length, included: selected, chars };
}

function log(event, fields = {}) { console.log(JSON.stringify({ event, ...fields })); }
function githubContext() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('Missing GitHub event context.');
  return fs.readFile(eventPath, 'utf8').then(JSON.parse);
}
function runUrl(repository) { return `https://github.com/${repository.full_name}/actions/runs/${process.env.GITHUB_RUN_ID ?? ''}`; }
async function githubRequest(url, options = {}) {
  const response = await fetch(url, { ...options, headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', ...options.headers,
  }});
  if (!response.ok) throw new Error(`GitHub API request failed (${response.status}).`);
  return response;
}
async function githubJson(url, options) { return (await githubRequest(url, options)).json(); }
async function paginate(url) {
  const all = [];
  let next = url.includes('?') ? `${url}&per_page=100` : `${url}?per_page=100`;
  while (next) {
    const response = await githubRequest(next); all.push(...await response.json());
    next = /<([^>]+)>; rel="next"/.exec(response.headers.get('link') ?? '')?.[1] ?? null;
  }
  return all;
}
async function addReaction(api, commentId) {
  await githubJson(`${api}/issues/comments/${commentId}/reactions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'eyes' }) });
}
async function postComment(api, issueNumber, body) {
  await githubJson(`${api}/issues/${issueNumber}/comments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }) });
}
async function exactHeadSha(checkoutPath) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  return (await promisify(execFile)('git', ['-C', checkoutPath, 'rev-parse', 'HEAD'])).stdout.trim();
}
function formatHistory(items) {
  if (!items.length) return '(No relevant prior review feedback selected.)';
  return items.map((item) => `- [${item.kind}; ${item.botFinding ? 'prior review-agent finding' : item.trusted ? 'trusted maintainer' : 'untrusted'}; ${item.createdAt}] ${item.author}${item.path ? ` on ${item.path}${item.line ? `:${item.line}` : ''}` : ''}:\n${item.body}`).join('\n');
}
function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (/OpenAI API key is not configured/.test(message)) return 'The OpenAI API key is not configured.';
  if (/Checked-out PR head/.test(message)) return 'The checked-out PR head could not be verified.';
  if (/GitHub API request failed/.test(message)) return message;
  if (/OpenAI request failed/.test(message)) return message;
  if (/OpenAI returned no review text/.test(message)) return message;
  return 'An internal review-agent error occurred.';
}
async function main() {
  const event = await githubContext();
  const command = parseReviewCommand(event.comment?.body);
  const valid = Boolean(event.issue?.pull_request && TRUSTED.has(event.comment?.author_association) && command);
  if (process.argv.includes('--validate')) {
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `accepted=${valid}\n`);
    return;
  }
  if (!valid) return;
  const api = event.repository.url;
  const prNumber = event.issue.number;
  try {
    await addReaction(api, event.comment.id);
    const pr = await githubJson(`${api}/pulls/${prNumber}`);
    const headSha = await exactHeadSha(process.env.PR_CHECKOUT_PATH);
    if (headSha !== pr.head.sha) throw new Error('Checked-out PR head did not match GitHub metadata.');
    const [files, issueComments, reviewComments, reviews, diffResponse] = await Promise.all([
      paginate(`${api}/pulls/${prNumber}/files`), paginate(`${api}/issues/${prNumber}/comments`),
      paginate(`${api}/pulls/${prNumber}/comments`), paginate(`${api}/pulls/${prNumber}/reviews`),
      githubRequest(`${api}/pulls/${prNumber}`, { headers: { Accept: 'application/vnd.github.v3.diff' } }),
    ]);
    const diff = truncate(await diffResponse.text(), DIFF_MAX_CHARS);
    const priorSuccess = issueComments.some((comment) => isSuccessfulReviewResult(comment, headSha));
    log('review_context', { pr_number: prNumber, head_sha: headSha, changed_files: files.length, diff_characters_sent: diff.length, deduplication_skipped: priorSuccess && !command.force });
    if (priorSuccess && !command.force) return;
    const history = selectReviewHistory({ reviewComments, issueComments, reviews, changedFiles: files });
    log('review_history', { comments_considered: history.considered, comments_included: history.included.length, history_characters_sent: history.chars });
    const [instructions, automationChecklist, checklist] = await Promise.all([
      fs.readFile(path.join(process.cwd(), '.github/prompts/gpt-pr-assistant.md'), 'utf8'),
      fs.readFile(path.join(process.cwd(), '.github/prompts/architecture-review-checklist.md'), 'utf8'),
      fs.readFile(path.join(process.cwd(), '.claude/skills/torch-air-architecture-review/checklist.md'), 'utf8'),
    ]);
    if (!process.env.OPENAI_API_KEY) throw new Error('The OpenAI API key is not configured.');
    const architectureApplies = files.some((file) => /(^|\/)(SKILL\.md|skills\/|frameworks\/|\.github\/prompts\/)/.test(file.filename));
    const input = `UNTRUSTED CURRENT MAINTAINER COMMAND PROMPT:\n${command.prompt || '(No additional prompt.)'}\n\nUNTRUSTED PR METADATA:\n${JSON.stringify({ number: pr.number, title: pr.title, body: truncate(pr.body, 8_000), head_sha: headSha })}\n\nUNTRUSTED CHANGED FILES:\n${files.map((file) => `${file.filename} (+${file.additions}/-${file.deletions})`).join('\n')}\n\nUNTRUSTED PR DIFF:\n${diff}\n\nUNTRUSTED COMPACT REVIEW HISTORY:\n${formatHistory(history.included)}${architectureApplies ? `\n\nTORCH-AIR ARCHITECTURE AUTOMATION SCOPE:\n${automationChecklist}\n\nTORCH-AIR CANONICAL ARCHITECTURE CHECKLIST:\n${checklist}` : ''}`;
    const started = Date.now();
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-terra', reasoning: { effort: 'medium' }, text: { verbosity: 'medium' }, store: false, instructions, input }) });
    const latencyMs = Date.now() - started;
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}).`);
    const result = await response.json();
    log('openai_response', { latency_ms: latencyMs, usage: result.usage ?? null });
    const output = String(result.output_text ?? '').trim();
    if (!output) throw new Error('OpenAI returned no review text.');
    await postComment(api, prNumber, `${output}\n\n${BOT_MARKER}${headSha} -->`);
  } catch (error) {
    const safe = safeFailureReason(error);
    log('review_failure', { pr_number: prNumber, reason: safe });
    await postComment(api, prNumber, `Review agent could not complete this run: ${safe} See [workflow logs](${runUrl(event.repository)}).\n\n<!-- review-agent: failure -->`).catch(() => {});
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
