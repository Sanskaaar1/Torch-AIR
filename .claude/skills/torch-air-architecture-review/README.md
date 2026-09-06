# Architecture Review

Assessment PRs that touch `SKILL.md`, `skills/`, `frameworks/`, or
`.claude/skills/` should be
reviewed against `.claude/skills/torch-air-architecture-review/checklist.md`
before merge. It's a reference checklist (skill structure, framework
nesting, scoring consistency, dispatch logic) — not a form to fill in.

Run it with the `torch-air-architecture-review` skill:

```
/torch-air-architecture-review <pr-number-or-url-or-branch>
```

This checks the PR's diff against the checklist and writes up whatever's
actually wrong as a fresh, problems-only review, organized by category, with
a final Recommendation (**Approve** / **Request Changes** / **Needs
Discussion**). Categories with nothing wrong are omitted — a clean PR gets a
short review, not a wall of passing checkmarks. By default it's a dry run —
nothing is posted to GitHub. Add `--post` to have it post the review to the
PR (inline comments per finding, verdict in the review body) after you
confirm the rendered output:

```
/torch-air-architecture-review 16 --post
```

To review manually instead, read
`.claude/skills/torch-air-architecture-review/checklist.md` and write up
findings the same way. See
[issue #17](https://github.com/TorchedHat/torch-air/issues/17) for the
tracking issue.

## GitHub Actions

Maintainers can ask Claude to inspect a pull request by adding a conversation
comment beginning with `@claude`; everything after the mention is their
prompt. For example:

```
@claude review this PR for architecture alignment and general issues
```

For a review request, Claude runs this architecture review when the changed
files are in scope and also performs the requested general review. For other
prompts, it answers or analyzes only what was requested. The workflow is
read-only and responds in one regular PR comment; it does not make commits,
approve PRs, submit formal reviews, or create inline comments.

Before enabling the workflow, install the
[Claude GitHub App](https://github.com/apps/claude) and configure GitHub
Actions workload identity federation for the Google Cloud service account
that can invoke Claude on Vertex AI. Create these repository Actions
variables:

- `GCP_WORKLOAD_IDENTITY_PROVIDER` — the full Google workload-identity
  provider resource name.
- `GCP_SERVICE_ACCOUNT` — the service-account email used by the workflow.
- `GCP_PROJECT_ID` — the Vertex AI project ID.
- `GCP_REGION` — the Vertex AI region where the selected Claude model is
  available.

No service-account JSON key or static API key is used or stored in GitHub.
Claude Code accepts prompts only from users with repository write permission;
the workflow does not check out or execute code from the PR head.
