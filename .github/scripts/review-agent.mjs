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
const OUTPUT_MAX_CHARS = 20_000;
const FORCE_COOLDOWN_MS = 15 * 60 * 1_000;
const FORCE_MAX_PER_HEAD = 2;
const BLOCKED_LABELS = new Set(['security', 'private', 'do-not-ai-review']);
const BOT_MARKER = '<!-- review-agent: success head_sha=';
const REVIEW_AGENT_MARKER = '<!-- review-agent:';
const EXCLUDED_DIFF_PATH = /(?:^|\/)(?:node_modules|vendor|dist|build|coverage)\/|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|cargo\.lock|poetry\.lock|composer\.lock)$|\.(?:min\.js|map|svg|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|mp3|mp4|woff2?)$/i;
const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          path: { type: 'string' }, line: { type: 'integer', minimum: 1 }, body: { type: 'string' },
        },
        required: ['severity', 'path', 'line', 'body'],
      },
    },
  },
  required: ['summary', 'findings'],
};

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

export function parseStructuredReview(value) {
  let review;
  try { review = JSON.parse(value); } catch { throw new Error('OpenAI returned invalid structured review output.'); }
  if (!review || typeof review.summary !== 'string' || !Array.isArray(review.findings) ||
    review.findings.some((finding) => !finding || !['high', 'medium', 'low'].includes(finding.severity) ||
      typeof finding.path !== 'string' || !Number.isInteger(finding.line) || finding.line < 1 ||
      typeof finding.body !== 'string' || !finding.body.trim())) {
    throw new Error('OpenAI returned invalid structured review output.');
  }
  return { summary: review.summary.trim(), findings: review.findings.map((finding) => ({ ...finding, path: finding.path.trim(), body: finding.body.trim() })) };
}

export function formatStructuredReview(review) {
  const findings = review.findings.map((finding) => `- **${finding.severity.toUpperCase()}** — \`${finding.path}:${finding.line}\`: ${finding.body}`).join('\n');
  return [findings ? `## Findings\n\n${findings}` : '', `## Summary\n\n${review.summary || 'No actionable issues found.'}`].filter(Boolean).join('\n\n');
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
  if (/invalid structured review output/.test(message)) return 'OpenAI returned an invalid structured review.';
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
    const rawInput = `<untrusted_command>\n${truncate(command.prompt, COMMAND_MAX_CHARS) || '(No additional prompt.)'}\n</untrusted_command>\n\n<untrusted_pr_metadata>\n${JSON.stringify({ number: pr.number, title: pr.title, body: truncate(pr.body, 8_000), head_sha: headSha })}\n</untrusted_pr_metadata>\n\n<untrusted_changed_files>\n${files.map((file) => `${file.filename} (+${file.additions}/-${file.deletions})`).join('\n')}\n</untrusted_changed_files>\n\n<untrusted_pr_diff>\n${diff}\n</untrusted_pr_diff>\n\n<untrusted_review_history>\n${formatHistory(history.included)}\n</untrusted_review_history>${architectureApplies ? `\n\n<trusted_architecture_checklist>\n${checklist}\n</trusted_architecture_checklist>` : ''}`;
    const { text: input, count: redactions } = redactSensitiveText(rawInput);
    log('review_input', { pr_number: prNumber, input_characters: input.length, redactions });
    const started = Date.now();
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', signal: AbortSignal.timeout(60_000), headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'gpt-5.6-terra', reasoning: { effort: 'medium' }, text: { verbosity: 'medium', format: { type: 'json_schema', name: 'pr_review', strict: true, schema: REVIEW_SCHEMA } }, max_output_tokens: 1_200, store: false, instructions, input }) });
    const latencyMs = Date.now() - started;
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}).`);
    const result = await response.json();
    const extracted = extractResponseText(result);
    log('openai_response', {
      latency_ms: latencyMs,
      status: result.status ?? null,
      output_items: Array.isArray(result.output) ? result.output.length : 0,
      extracted_text_characters: extracted.length,
      usage: result.usage ?? null,
    });
    if (!isCompletedResponse(result)) throw new Error('OpenAI response did not complete.');
    if (!extracted) throw new Error('OpenAI returned no review text.');
    const output = sanitizeReviewOutput(formatStructuredReview(parseStructuredReview(extracted)));
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
