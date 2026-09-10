#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const HISTORY_MAX_ITEMS = 30;
const HISTORY_MAX_CHARS = 8_000;
const DIFF_MAX_CHARS = 120_000;
const COMMAND_MAX_CHARS = 2_000;
const OUTPUT_MAX_CHARS = 20_000;
// Responses has no input-token limit parameter. 64k characters was calibrated
// from the failed run (90,815 chars = 23,034 tokens) to target ~16k input
// tokens while retaining the highest-priority review context.
const INPUT_MAX_CHARS = 64_000;
const INITIAL_MAX_OUTPUT_TOKENS = 4_096;
const RETRY_MAX_OUTPUT_TOKENS = 6_144;
const FORCE_COOLDOWN_MS = 15 * 60 * 1_000;
const FORCE_MAX_PER_HEAD = 2;
const BLOCKED_LABELS = new Set(['security', 'private', 'do-not-ai-review']);
const BOT_MARKER = '<!-- review-agent: success head_sha=';
const REVIEW_AGENT_MARKER = '<!-- review-agent:';
const EXCLUDED_DIFF_PATH = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)\/|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|composer\.lock)$|\.(?:min\.js|map|svg|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp3|mp4|woff2?)$/i;

export function parseReviewCommand(body = '') {
  const match = /(?:^|\r?\n)[ \t]*@review-agent(?=$|[ \t])(?:[ \t]*(.*))?/.exec(body);
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
    (comment.body?.includes(`${BOT_MARKER}${headSha} -->`) ||
      comment.body?.includes(`${BOT_MARKER}${headSha} attempt=force -->`));
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

export function isCompletedResponse(response) {
  return response?.status === 'completed';
}

export function formatDeduplicationComment(headSha) {
  return `No changes have been made since the previous successful review of this PR head, so no new review was run.\n\n<!-- review-agent: skipped head_sha=${headSha} -->`;
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
  const output = String(value ?? '').trim();
  if (output.length > OUTPUT_MAX_CHARS) throw new Error('OpenAI returned review text that exceeded the safe output limit.');
  return output
    .replace(/!\[[^\]]*\]\([^\s)]+\)/g, '[external image omitted]')
    .replace(/@(?=[A-Za-z0-9-]{1,39}\b)/g, '@\u200B');
}

export function buildReviewableDiff(files = []) {
  return truncate(files
    .filter((file) => typeof file?.filename === 'string' && !EXCLUDED_DIFF_PATH.test(file.filename))
    .flatMap((file) => typeof file.patch === 'string' && file.patch.trim()
      ? [`diff --git a/${file.filename} b/${file.filename}\n${file.patch}`] : [])
    .join('\n'), DIFF_MAX_CHARS);
}

export function buildReviewInput({ commandPrompt, pr, headSha, files, diff, history, checklist, architectureApplies }) {
  let input = '';
  let truncated = false;
  const append = (tag, value) => {
    const opening = `<${tag}>\n`;
    const closing = `\n</${tag}>`;
    const remaining = INPUT_MAX_CHARS - input.length - opening.length - closing.length;
    if (remaining <= 0) { truncated = true; return; }
    const text = String(value ?? '');
    const clipped = text.length <= remaining ? text : `${text.slice(0, Math.max(0, remaining - 12))}\n[truncated]`;
    if (clipped.length < text.length) truncated = true;
    input += `${opening}${clipped}${closing}\n\n`;
  };
  append('untrusted_command', truncate(commandPrompt, COMMAND_MAX_CHARS) || '(No additional prompt.)');
  append('untrusted_pr_metadata', JSON.stringify({ number: pr.number, title: pr.title, body: truncate(pr.body, 8_000), head_sha: headSha }));
  append('untrusted_changed_files', files.map((file) => `${file.filename} (+${file.additions}/-${file.deletions})`).join('\n'));
  if (architectureApplies) append('trusted_architecture_checklist', checklist);
  // History is supplemental but precedes the diff so prior unresolved findings
  // remain available when a large diff must be clipped.
  append('untrusted_review_history', formatHistory(history));
  append('untrusted_pr_diff', diff);
  return { input: input.trim(), truncated };
}

export function shouldRetryForOutputLimit(response) {
  return response?.status === 'incomplete' && response?.incomplete_details?.reason === 'max_output_tokens';
}

export function isAllowedGithubApiUrl(value, apiUrl = process.env.GITHUB_API_URL ?? 'https://api.github.com') {
  try { return new URL(value).origin === new URL(apiUrl).origin && new URL(value).protocol === 'https:'; } catch { return false; }
}

function truncate(value, limit) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[truncated]`;
}

function itemFromComment(comment, kind, changedPaths) {
  const body = String(comment.body ?? '');
  const isReviewAgentBot = comment.user?.login === 'github-actions[bot]' && body.includes(REVIEW_AGENT_MARKER);
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
  return items.map((item) => `- [${item.kind}; ${item.botFinding ? 'prior review-agent finding' : item.trusted ? 'trusted maintainer' : 'untrusted'}; ${item.createdAt}] ${item.author}${item.path ? ` on ${item.path}${item.line ? `:${item.line}` : ''}` : ''}:\n${item.body}`).join('\n');
}
function safeFailureReason(error) {
  const message = error instanceof Error ? error.message : '';
  if (/OpenAI API key is not configured/.test(message)) return 'The OpenAI API key is not configured.';
  if (/Checked-out PR head/.test(message)) return 'The checked-out PR head could not be verified.';
  if (/GitHub API request failed/.test(message)) return message;
  if (/OpenAI request failed/.test(message)) return message;
  if (/OpenAI response did not complete/.test(message)) return 'OpenAI did not complete the review.';
  if (/OpenAI returned no review text/.test(message)) return message;
  if (/safe output limit/.test(message)) return 'OpenAI returned review text that exceeded the safe output limit.';
  if (/GitHub API URL was not allowed/.test(message)) return 'A GitHub API URL was rejected by the review agent.';
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
  let headSha = null;
  try {
    // A reaction is only an acknowledgement. Some repositories or token
    // policies deny reactions even when normal issue comments are allowed;
    // do not let that cosmetic operation prevent the requested review.
    await addReaction(api, event.comment.id).catch((error) => {
      log('review_warning', { pr_number: prNumber, operation: 'acknowledgement_reaction', reason: safeFailureReason(error) });
    });
    if (command.force && event.comment.author_association !== 'OWNER') {
      await postComment(api, prNumber, 'Only repository owners may use `@review-agent --force`; no review was run.\n\n<!-- review-agent: rejected reason=force_requires_owner -->');
      return;
    }
    const pr = await githubJson(`${api}/pulls/${prNumber}`);
    headSha = await exactHeadSha(process.env.PR_CHECKOUT_PATH);
    if (headSha !== pr.head.sha) throw new Error('Checked-out PR head did not match GitHub metadata.');
    const [files, issueComments, reviewComments, reviews] = await Promise.all([
      paginate(`${api}/pulls/${prNumber}/files`), paginate(`${api}/issues/${prNumber}/comments`),
      paginate(`${api}/pulls/${prNumber}/comments`), paginate(`${api}/pulls/${prNumber}/reviews`),
    ]);
    const diff = buildReviewableDiff(files);
    const excludedFiles = files.filter((file) => EXCLUDED_DIFF_PATH.test(String(file.filename ?? ''))).length;
    const blockedLabel = (pr.labels ?? []).map((label) => String(label.name ?? '').toLowerCase()).find((name) => BLOCKED_LABELS.has(name));
    if (blockedLabel) {
      log('review_rejected', { pr_number: prNumber, reason: 'blocked_label', label: blockedLabel });
      await postComment(api, prNumber, `Review agent did not run because this PR has the \`${blockedLabel}\` label.\n\n<!-- review-agent: rejected reason=blocked_label -->`);
      return;
    }
    const attempts = issueComments.filter((comment) => comment.user?.login === 'github-actions[bot]' && comment.body?.includes(`head_sha=${headSha}`));
    const latestAttempt = attempts.map((comment) => Date.parse(comment.created_at ?? comment.updated_at ?? '')).filter(Number.isFinite).sort((a, b) => b - a)[0];
    if (command.force && latestAttempt && Date.now() - latestAttempt < FORCE_COOLDOWN_MS) {
      log('review_rejected', { pr_number: prNumber, reason: 'force_cooldown', head_sha: headSha });
      await postComment(api, prNumber, 'A review for this PR head ran recently. Wait 15 minutes before forcing another review.\n\n<!-- review-agent: rejected reason=force_cooldown -->');
      return;
    }
    const forcedAttempts = attempts.filter((comment) => comment.body?.includes('attempt=force')).length;
    if (command.force && forcedAttempts >= FORCE_MAX_PER_HEAD) {
      log('review_rejected', { pr_number: prNumber, reason: 'force_limit', head_sha: headSha });
      await postComment(api, prNumber, 'This PR head has reached its limit of two forced reviews. Push a new commit before requesting another.\n\n<!-- review-agent: rejected reason=force_limit -->');
      return;
    }
    const priorSuccess = issueComments.some((comment) => isSuccessfulReviewResult(comment, headSha));
    log('review_context', { pr_number: prNumber, head_sha: headSha, changed_files: files.length, reviewable_files: files.length - excludedFiles, excluded_files: excludedFiles, diff_characters_sent: diff.length, deduplication_skipped: priorSuccess && !command.force });
    if (priorSuccess && !command.force) {
      await postComment(api, prNumber, formatDeduplicationComment(headSha));
      return;
    }
    const history = selectReviewHistory({ reviewComments, issueComments, reviews, changedFiles: files });
    log('review_history', { comments_considered: history.considered, comments_included: history.included.length, history_characters_sent: history.chars });
    const [instructions, checklist] = await Promise.all([
      fs.readFile(path.join(process.cwd(), '.github/prompts/review-agent.md'), 'utf8'),
      fs.readFile(path.join(process.cwd(), '.github/prompts/architecture-review-checklist.md'), 'utf8'),
    ]);
    if (!process.env.OPENAI_API_KEY) throw new Error('The OpenAI API key is not configured.');
    const architectureApplies = files.some((file) => /(^|\/)(SKILL\.md|skills\/|frameworks\/|\.github\/prompts\/)/.test(file.filename));
    const reviewInput = buildReviewInput({ commandPrompt: command.prompt, pr, headSha, files, diff, history: history.included, checklist, architectureApplies });
    const { text: input, count: redactions } = redactSensitiveText(reviewInput.input);
    log('review_input', { pr_number: prNumber, input_characters: input.length, input_budget_characters: INPUT_MAX_CHARS, truncated: reviewInput.truncated, redactions });
    const started = Date.now();
    const requestReview = (maxOutputTokens) => fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-terra', text: { verbosity: 'medium' }, max_output_tokens: maxOutputTokens, store: false, instructions, input }) });
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
    if (!isCompletedResponse(result)) throw new Error('OpenAI response did not complete.');
    if (!extracted) throw new Error('OpenAI returned no review text.');
    const output = sanitizeReviewOutput(extracted);
    await postComment(api, prNumber, `${output}\n\n${BOT_MARKER}${headSha}${command.force ? ' attempt=force' : ''} -->`);
  } catch (error) {
    const safe = safeFailureReason(error);
    log('review_failure', { pr_number: prNumber, reason: safe });
    const marker = headSha ? `<!-- review-agent: failure head_sha=${headSha}${command.force ? ' attempt=force' : ''} -->` : '<!-- review-agent: failure -->';
    await postComment(api, prNumber, `Review agent could not complete this run: ${safe} See [workflow logs](${runUrl(event.repository)}).\n\n${marker}`).catch(() => {});
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
