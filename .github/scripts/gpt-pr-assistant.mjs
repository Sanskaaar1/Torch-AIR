import { readFile } from 'node:fs/promises';

const apiBase = 'https://api.github.com';
const openaiUrl = 'https://api.openai.com/v1/responses';
const maxDiffChars = 250_000;
const trustedAssociations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github(path, options = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${required('GITHUB_TOKEN')}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`GitHub API ${response.status} for ${path}: ${detail}`);
  }
  return response;
}

function promptAfterCommand(body) {
  const match = body.match(/(?:^|\n)[\t ]*@review-agent(?:[\t ]+([\s\S]*))?$/i);
  return match ? match[1]?.trim() || 'Review this pull request.' : null;
}

function responseText(response) {
  if (response.output_text) return response.output_text;
  return response.output
    ?.filter((item) => item.type === 'message')
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === 'output_text')
    .map((item) => item.text)
    .join('\n') || '';
}

const event = JSON.parse(await readFile(required('GITHUB_EVENT_PATH'), 'utf8'));
if (!event.issue?.pull_request || !trustedAssociations.has(event.comment?.author_association)) {
  process.exit(0);
}

const repository = required('GITHUB_REPOSITORY');
const prNumber = event.issue.number;
const maintainerPrompt = promptAfterCommand(event.comment.body);
if (maintainerPrompt === null) process.exit(0);
const [owner, repo] = repository.split('/');
await github(`/repos/${owner}/${repo}/issues/comments/${event.comment.id}/reactions`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'eyes' }),
});
const [pr, filesResponse, diffResponse, guide, checklist] = await Promise.all([
  github(`/repos/${owner}/${repo}/pulls/${prNumber}`).then((response) => response.json()),
  github(`/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100`).then((response) => response.json()),
  github(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: { Accept: 'application/vnd.github.v3.diff' },
  }).then((response) => response.text()),
  readFile('.github/prompts/gpt-pr-assistant.md', 'utf8'),
  readFile('.github/prompts/architecture-review-checklist.md', 'utf8'),
]);

const diff = diffResponse.length > maxDiffChars
  ? `${diffResponse.slice(0, maxDiffChars)}\n\n[Diff truncated at ${maxDiffChars} characters.]`
  : diffResponse;
const changedFiles = filesResponse.map((file) => ({
  path: file.filename,
  status: file.status,
  additions: file.additions,
  deletions: file.deletions,
}));

const instructions = `${guide}\n\n--- Architecture checklist ---\n${checklist}`;
const input = `Maintainer prompt:\n${maintainerPrompt}\n\n--- Pull request metadata ---\n${JSON.stringify({
  number: pr.number,
  title: pr.title,
  body: pr.body,
  author: pr.user?.login,
  base: pr.base?.ref,
  head: pr.head?.ref,
  changedFiles,
}, null, 2)}\n\n--- Untrusted PR diff ---\n${diff}`;

const openaiResponse = await fetch(openaiUrl, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${required('OPENAI_API_KEY')}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    model: 'gpt-5.6-terra',
    instructions,
    input,
    reasoning: { effort: 'medium' },
    text: { verbosity: 'medium' },
    max_output_tokens: 4_000,
    store: false,
  }),
});
if (!openaiResponse.ok) throw new Error(`OpenAI API ${openaiResponse.status}`);

const answer = responseText(await openaiResponse.json());
if (!answer) throw new Error('OpenAI returned no response text');

await github(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body: `## GPT PR Assistant\n\n${answer}` }),
});
