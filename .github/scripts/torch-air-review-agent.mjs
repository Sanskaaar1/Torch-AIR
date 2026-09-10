#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const HISTORY_MAX_ITEMS = 30;
const HISTORY_MAX_CHARS = 24_000;
const DIFF_MAX_CHARS = 120_000;
const COMMAND_MAX_CHARS = 2_000;
const PR_BODY_MAX_CHARS = 8_000;
const FILES_MAX_CHARS = 8_000;
const OUTPUT_MAX_CHARS = 32_000;
// Responses has no input-token limit parameter. This ceiling targets roughly
// 48k input tokens while giving the current diff its own non-competing budget.
const INPUT_MAX_CHARS = 192_000;
const INITIAL_MAX_OUTPUT_TOKENS = 4_096;
const RETRY_MAX_OUTPUT_TOKENS = 6_144;
const FORCE_COOLDOWN_MS = 15 * 60 * 1_000;
const FORCE_MAX_PER_HEAD = 2;
const BLOCKED_LABELS = new Set(['security', 'private', 'do-not-ai-review']);
const BOT_MARKER = '<!-- torch-air-review-agent: success head_sha=';
const FINAL_MARKER = /(?:^|\r?\n)<!-- torch-air-review-agent: [^\r\n]* -->\r?$/;

export function parseReviewCommand(body = '') {
  const match = /(?:^|\r?\n)[ \t]*@torch-air-review-agent(?=$|[ \t])(?:[ \t]*(.*))?/.exec(body);
  if (!match) return null;
  const commandEnd = match.index + match[0].length;
  const firstLinePrompt = match[1] ?? '';
  const remainder = body.slice(commandEnd);
  const prompt = `${firstLinePrompt}${remainder}`.trim();
  const force = /(?:^|\s)--force(?=$|\s)/.test(prompt);
  return { force, prompt: prompt.replace(/(?:^|\s)--force(?=$|\s)/g, ' ').trim() };
}

export function isSuccessfulReviewResult(comment, headSha) {
  if (comment?.user?.login !== 'github-actions[bot]') return false;
  const escaped = String(headSha).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\r?\\n)${BOT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${escaped}(?: attempt=force)? -->\\r?$`).test(String(comment.body ?? ''));
}

export function extractResponseText(response) {
  const sdkText = typeof response?.output_text === 'string' ? response.output_text.trim() : '';
  if (sdkText) return sdkText;

  const parts = Array.isArray(response?.output) ? response.output.flatMap((item) => {
    if (item?.type !== 'message' || !Array.isArray(item.content)) return [];
    return item.content
      .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text);
  }) : [];
  return parts.join('\n').trim();
}

export function formatDeduplicationComment(headSha) {
  return `No changes have been made since the previous successful review of this PR head, so no new review was run.\n\n<!-- torch-air-review-agent: skipped head_sha=${headSha} -->`;
}

export function redactSensitiveText(value) {
  let count = 0;
  const redact = (text, pattern) => text.replace(pattern, () => { count += 1; return '[REDACTED]'; });
  let text = String(value ?? '');
  text = redact(text, /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g);
  text = redact(text, /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk(?:-proj)?-[A-Za-z0-9_-]{20,})\b/g);
  text = redact(text, /\bAKIA[0-9A-Z]{16}\b/g);
  return { text, count };
}

export function sanitizeReviewOutput(value) {
  const output = String(value ?? '').trim()
    .replace(/<!--\s*torch-air-review-agent:[\s\S]*?-->/gi, '')
    .replace(/!\[[^\]]*\]\([^\s)]+\)/g, '[external image omitted]')
    .replace(/@(?=[A-Za-z0-9-]{1,39}\b)/g, '@\u200B')
    .trim();
  if (output.length > OUTPUT_MAX_CHARS) throw new Error('OpenAI returned review text that exceeded the safe output limit.');
  return output;
}

export function buildReviewInput({ commandPrompt, pr, headSha, files, diff, history, checklist, architectureApplies }) {
  const raw = {
    command: String(commandPrompt ?? '') || '(No additional prompt.)',
    metadata: JSON.stringify({ number: pr.number, title: truncate(pr.title, 2_000), body: truncate(pr.body, PR_BODY_MAX_CHARS), head_sha: headSha }),
    files: files.map((file) => `${file.filename} (+${file.additions}/-${file.deletions})`).join('\n'),
    history: formatHistory(history),
    diff: String(diff ?? ''),
  };
  const values = {
    command: truncate(raw.command, COMMAND_MAX_CHARS), metadata: raw.metadata,
    files: truncate(raw.files, FILES_MAX_CHARS), history: truncate(raw.history, HISTORY_MAX_CHARS),
    diff: truncate(raw.diff, DIFF_MAX_CHARS), checklist: architectureApplies ? String(checklist ?? '') : '',
  };
  const section = (tag, value) => `<${tag}>\n${value}\n</${tag}>`;
  const parts = [section('untrusted_command', values.command), section('untrusted_pr_metadata', values.metadata),
    section('untrusted_changed_files', values.files),
    ...(architectureApplies ? [section('trusted_architecture_checklist', values.checklist)] : []),
    section('untrusted_review_history', values.history), section('untrusted_pr_diff', values.diff)];
  const input = parts.join('\n\n');
  if (input.length > INPUT_MAX_CHARS) throw new Error('Review input exceeded its fixed section budgets.');
  return { input, truncated: Object.keys(raw).some((key) => values[key] !== raw[key]), diffTruncated: values.diff !== raw.diff };
}

export function shouldRetryForOutputLimit(response) {
  return response?.status === 'incomplete' && response?.incomplete_details?.reason === 'max_output_tokens';
}

export function isAllowedGithubApiUrl(value, apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com') {
  try { return new URL(value).origin === new URL(apiUrl).origin && new URL(value).protocol === 'https:'; } catch { return false; }
}

function truncate(value, limit) {
  const text = String(value ?? '');
  const marker = '\n[truncated]';
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - marker.length))}${marker}`;
}

function itemFromComment(comment, kind, changedPaths) {
  const body = String(comment.body ?? '');
  const isReviewAgentBot = comment.user?.login === 'github-actions[bot]' && FINAL_MARKER.test(body);
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
  if (!isAllowedGithubApiUrl(url)) throw new Error('GitHub API URL was not allowed.');
  const response = await fetch(url, { ...options, headers: {
    Accept: 'application/vnd.github+json', Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28', ...options.headers,
  }, signal: options.signal ?? AbortSignal.timeout(30_000) });
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
  return items.map((item) => `- [${item.kind}; ${item.botFinding ? 'prior torch-air-review-agent finding' : item.trusted ? 'trusted maintainer' : 'untrusted'}; ${item.createdAt}] ${item.author}${item.path ? ` on ${item.path}${item.line ? `:${item.line}` : ''}` : ''}:\n${item.body}`).join('\n');
}
export function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (/OpenAI API key is not configured/.test(message)) return 'The OpenAI API key is not configured.';
  if (/Checked-out PR head/.test(message)) return 'The checked-out PR head could not be verified.';
  if (/GitHub API request failed/.test(message)) return message;
  if (/OpenAI request failed/.test(message)) return message;
  if (/OpenAI request timed out/.test(message) || error?.name === 'TimeoutError') return 'The OpenAI request timed out.';
  if (/GitHub reported changed files but returned no diff/.test(message)) return message;
  if (/OpenAI response did not complete/.test(message)) return 'OpenAI did not complete the review.';
  if (/OpenAI returned no review text/.test(message)) return message;
  if (/safe output limit/.test(message)) return 'OpenAI returned review text that exceeded the safe output limit.';
  if (/GitHub API URL was not allowed/.test(message)) return 'A GitHub API URL was rejected by the review agent.';
  return 'An internal torch-air-review-agent error occurred.';
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
  let headSha = null;
  try {
    // A reaction is only an acknowledgement. Some repositories or token
    // policies deny reactions even when normal issue comments are allowed;
    // do not let that cosmetic operation prevent the requested review.
    await addReaction(api, event.comment.id).catch((error) => {
      log('review_warning', { pr_number: prNumber, operation: 'acknowledgement_reaction', reason: safeFailureReason(error) });
    });
    if (command.force && event.comment.author_association !== 'OWNER') {
      await postComment(api, prNumber, 'Only repository owners may use `@torch-air-review-agent --force`; no review was run.\n\n<!-- torch-air-review-agent: rejected reason=force_requires_owner -->');
      return;
    }
    const pr = await githubJson(`${api}/pulls/${prNumber}`);
    headSha = await exactHeadSha(process.env.PR_CHECKOUT_PATH);
    if (headSha !== pr.head.sha) throw new Error('Checked-out PR head did not match GitHub metadata.');
    const [files, issueComments, reviewComments, reviews, diffResponse] = await Promise.all([
      paginate(`${api}/pulls/${prNumber}/files`), paginate(`${api}/issues/${prNumber}/comments`),
      paginate(`${api}/pulls/${prNumber}/comments`), paginate(`${api}/pulls/${prNumber}/reviews`),
      githubRequest(`${api}/pulls/${prNumber}`, { headers: { Accept: 'application/vnd.github.v3.diff' } }),
    ]);
    const rawDiff = await diffResponse.text();
    if (files.length > 0 && !rawDiff.trim()) throw new Error('GitHub reported changed files but returned no diff.');
    const diff = truncate(rawDiff, DIFF_MAX_CHARS);
    const blockedLabel = (pr.labels ?? []).map((label) => String(label.name ?? '').toLowerCase()).find((name) => BLOCKED_LABELS.has(name));
    if (blockedLabel) {
      log('review_rejected', { pr_number: prNumber, reason: 'blocked_label', label: blockedLabel });
      await postComment(api, prNumber, `Review agent did not run because this PR has the \`${blockedLabel}\` label.\n\n<!-- torch-air-review-agent: rejected reason=blocked_label -->`);
      return;
    }
    const successfulForcedReviews = issueComments.filter((comment) => isSuccessfulReviewResult(comment, headSha) && String(comment.body).replace(/\r$/, '').endsWith(`${BOT_MARKER}${headSha} attempt=force -->`));
    const latestForcedSuccess = successfulForcedReviews.map((comment) => Date.parse(comment.created_at ?? comment.updated_at ?? '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (command.force && latestForcedSuccess && Date.now() - latestForcedSuccess < FORCE_COOLDOWN_MS) {
      log('review_rejected', { pr_number: prNumber, reason: 'force_cooldown', head_sha: headSha });
      await postComment(api, prNumber, 'A review for this PR head ran recently. Wait 15 minutes before forcing another review.\n\n<!-- torch-air-review-agent: rejected reason=force_cooldown -->');
      return;
    }
    if (command.force && successfulForcedReviews.length >= FORCE_MAX_PER_HEAD) {
      log('review_rejected', { pr_number: prNumber, reason: 'force_limit', head_sha: headSha });
      await postComment(api, prNumber, 'This PR head has reached its limit of two forced reviews. Push a new commit before requesting another.\n\n<!-- torch-air-review-agent: rejected reason=force_limit -->');
      return;
    }
    const priorSuccess = issueComments.some((comment) => isSuccessfulReviewResult(comment, headSha));
    log('review_context', { pr_number: prNumber, head_sha: headSha, changed_files: files.length, diff_characters_received: rawDiff.length, diff_characters_sent: diff.length, diff_truncated: diff.length !== rawDiff.length, deduplication_skipped: priorSuccess && !command.force });
    if (priorSuccess && !command.force) {
      await postComment(api, prNumber, formatDeduplicationComment(headSha));
      return;
    }
    const history = selectReviewHistory({ reviewComments, issueComments, reviews, changedFiles: files });
    log('review_history', { comments_considered: history.considered, comments_included: history.included.length, history_characters_sent: history.chars });
    const [instructions, checklist] = await Promise.all([
      fs.readFile(path.join(process.cwd(), '.github/prompts/torch-air-review-agent.md'), 'utf8'),
      fs.readFile(path.join(process.cwd(), '.github/prompts/architecture-review-checklist.md'), 'utf8'),
    ]);
    if (!process.env.OPENAI_API_KEY) throw new Error('The OpenAI API key is not configured.');
    const architectureApplies = files.some((file) => /(^|\/)(SKILL\.md|skills\/|frameworks\/|\.github\/prompts\/)/.test(file.filename));
    const reviewInput = buildReviewInput({ commandPrompt: command.prompt, pr, headSha, files, diff, history: history.included, checklist, architectureApplies });
    const { text: input, count: redactions } = redactSensitiveText(reviewInput.input);
    log('review_input', { pr_number: prNumber, input_characters: input.length, input_budget_characters: INPUT_MAX_CHARS, truncated: reviewInput.truncated, redactions });
    const started = Date.now();
    const requestReview = async (maxOutputTokens) => {
      try {
        return await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(180_000), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-terra', text: { verbosity: 'medium' }, max_output_tokens: maxOutputTokens, store: false, instructions, input }) });
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error('OpenAI request timed out.');
        throw error;
      }
    };
    let response = await requestReview(INITIAL_MAX_OUTPUT_TOKENS);
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}).`);
    let result = await response.json();
    if (shouldRetryForOutputLimit(result)) {
      log('openai_retry', { pr_number: prNumber, reason: result.incomplete_details.reason, max_output_tokens: RETRY_MAX_OUTPUT_TOKENS });
      response = await requestReview(RETRY_MAX_OUTPUT_TOKENS);
      if (!response.ok) throw new Error(`OpenAI request failed (${response.status}).`);
      result = await response.json();
    }
    const latencyMs = Date.now() - started;
    const extracted = extractResponseText(result);
    log('openai_response', {
      latency_ms: latencyMs,
      status: result.status ?? null,
      output_items: Array.isArray(result.output) ? result.output.length : 0,
      extracted_text_characters: extracted.length,
      incomplete_details: result.incomplete_details ?? null,
      usage: result.usage ?? null,
    });
    if (result.status !== 'completed') throw new Error('OpenAI response did not complete.');
    if (!extracted) throw new Error('OpenAI returned no review text.');
    const output = sanitizeReviewOutput(extracted);
    if (!output) throw new Error('OpenAI returned no review text.');
    await postComment(api, prNumber, `${output}\n\n${BOT_MARKER}${headSha}${command.force ? ' attempt=force' : ''} -->`);
  } catch (error) {
    const safe = safeFailureReason(error);
    log('review_failure', { pr_number: prNumber, reason: safe });
    const marker = headSha ? `<!-- torch-air-review-agent: failure head_sha=${headSha}${command.force ? ' attempt=force' : ''} -->` : '<!-- torch-air-review-agent: failure -->';
    await postComment(api, prNumber, `Review agent could not complete this run: ${safe} See [workflow logs](${runUrl(event.repository)}).\n\n${marker}`).catch(() => {});
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
