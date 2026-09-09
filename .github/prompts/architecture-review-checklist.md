# Torch-AIR Architecture Review Checklist

Use this checklist for PRs that change `SKILL.md`, `skills/`, `frameworks/`,
or `.github/prompts/`. It is reference material, not a template: report only
violations that the diff and supplied context substantiate.

## Framework vs. Evaluation Dimension

Neither case creates another accelerator-evaluation command. The existing
`torch-accelerator-readiness` skill is the single entry point.

- A **new framework** is a fundamentally different integration target/runtime.
  It has `frameworks/<name>/` and a Framework Dispatch table entry.
- An **evaluation dimension** is a new scoring lens (security, performance,
  compliance) on an existing target. It is nested at
  `frameworks/<framework>/<dimension>/` and reached by an explicit flag.
- If uncertain, classify the change as a dimension.

## Skill Structure

- One skill handles accelerator evaluation: neither a framework nor a
  dimension becomes a standalone skill or command.
- New dimension flags have default, individual, and combined (`--all`)
  invocation examples in `SKILL.md`.
- The default invocation remains base functional evaluation only.
- `skills/torch-accelerator-readiness/SKILL.md` remains a symlink to
  `../../SKILL.md`, not a duplicate file.
- Users are directed to a flag, not another skill, for a dimension.

## Framework Nesting

- A dimension has `frameworks/<framework>/<dimension>/checklist.md` and
  `EVAL.md`; it is never a peer `frameworks/<dimension>/`.
- Framework-specific material remains under its framework directory.
- A new framework includes `checklist.md`, `EVAL.md`, and a Framework Dispatch
  entry.
- Adding framework #2 generalizes the shared summary output instead of adding
  another hardcoded framework block.
- The repository tree in `README.md` matches structural changes.
- Every new checklist row has a corresponding `EVAL.md` phase that gathers
  evidence.

## Scoring Consistency

Reference model:

```
Row weight:     w_i = 1 / priority_i
Section %:      sum(score_i * w_i) / sum(2 * w_i) * 100 (N/A excluded)
Tier weight:    weight_r = 1 / level
Overall %:      sum(section_pct * weight_r) / sum(weight_r) * 100
```

- Rows use `0`/`1`/`2`/`N/A`, not qualitative-only labels.
- Overall readiness is a computed weighted percentage.
- Each row has a fixed Priority (1 critical, 2 important, 3 nice-to-have).
- Sections state Levels 1–3 and `weight = 1 / level`.
- Any formula divergence is explicitly justified in the PR.
- A standard Executive Summary, Section Scores, and overall percentage appear
  before detailed rows.
- Domain results roll up into section and overall scores; no unrelated parallel
  score is introduced.

## Dispatch & Orchestration

- The Framework Dispatch table lists frameworks only; dimensions are reached
  by flags.
- A dimension's flag scopes its phases and `EVAL.md` loading explicitly.
- Multiple dimensions require a documented explicit combined flag, never
  implicit default behavior.
- Dimension phases remain in their nested `EVAL.md`, not the base framework
  file.
- Reports follow `torch-air-report/<type>_report_<backend>.md`.

## General Conventions

- Generated reports target the git-ignored `torch-air-report/` directory.
- Assessment-surface changes update `README.md`.
- `EVAL.md` keeps internal rubrics and phase instructions out of reports.
- Each probe is failure-isolated; partial implementations still yield partial
  reports.
- Unverifiable items are marked "Requires manual verification," never skipped
  or guessed.
- `plugin.json` retains `./skills/` as its skills path.
- Checklist structural changes are separated and labeled from content edits.
- Scored findings cite concrete evidence: file/line, command output, or URL.

## Always Request Changes

Recommend **Request Changes** for any of these:

- A framework or dimension is introduced as a standalone accelerator skill.
- A dimension is a peer framework directory rather than nested under its
  framework.
- A checklist uses qualitative-only scoring instead of the numeric weighted
  model.
- A dimension is in the Framework Dispatch table or is reachable without an
  explicit flag.
