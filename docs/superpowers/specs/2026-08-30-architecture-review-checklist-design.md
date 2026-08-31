# Architecture Review Checklist — Design Spec

**Date:** 2026-08-30  
**Issue:** [#17 — Create automated review agent for assessment skills PRs](https://github.com/TorchedHat/torch-air/issues/17)  
**Scope:** Checklist only (review agent / `EVAL.md` deferred)  
**Status:** Implemented

---

## Problem

Torch-AIR is growing beyond functional PyTorch integration readiness. New assessment PRs (e.g. [#16 — security readiness](https://github.com/TorchedHat/torch-air/pull/16)) can violate architectural conventions because review criteria live in ad-hoc PR comments, not a repeatable checklist.

PR #16 review (`mansiag05`) identified four structural misalignments:

1. **Separate skill** instead of flags on `torch-accelerator-readiness`
2. **Peer framework** (`frameworks/security/`) instead of nesting under `frameworks/pytorch/`
3. **Qualitative scoring** (PASS/PARTIAL/FAIL) instead of numeric 0/1/2/N/A with weighted %
4. **Dispatch table conflict** — optional dimension in dispatch table + "follow all phases" causes unintended cross-triggering

Issue #17 calls for a review agent and a checklist of architectural patterns. This spec defines the checklist first.

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary consumers | Human reviewers + automated agent | Single source of truth; issue #17 needs both |
| PR scope | Assessment PRs + skill/orchestrator changes | Covers `SKILL.md`, `skills/`, `frameworks/` without noise on unrelated doc edits |
| File format | Single markdown with inline agent checks | Token-efficient; no sync drift between paired files |
| Location | `frameworks/review/checklist.md` | Mirrors `frameworks/pytorch/` pattern (Approach 2) |
| Agent orchestration | Deferred (`frameworks/review/EVAL.md` + skill later) | User requested checklist-first focus |

---

## File Layout

```
frameworks/review/
├── checklist.md    # ← this spec defines content (implement next)
└── EVAL.md         # deferred — PR diff workflow, comment posting
```

`frameworks/review/` is **meta-infrastructure**. It must never appear in the functional Framework Dispatch table in `SKILL.md`.

---

## Document Structure

### Header metadata (filled per PR review)

| Field | Example |
|-------|---------|
| PR number / URL | `#16` |
| Author | `krastogi-in` |
| Review date | `2026-08-30` |
| Reviewer | agent / human |
| PR type | `new-evaluation-dimension` / `new-framework` / `orchestrator-change` |
| Files touched | `skills/`, `frameworks/`, `SKILL.md` |

### Summary block (filled after review)

- Per-section PASS/FAIL counts
- **Verdict:** `APPROVE` / `CHANGES_REQUESTED`
- Blocking failures listed by item ID (e.g. `SK-01`, `FN-02`)

### Row format

Each checklist item is one table row:

| ID | Rule | Severity | Result | Notes | Agent check |
|----|------|----------|--------|-------|-------------|
| SK-01 | … | BLOCKING | PASS/FAIL/N/A | evidence | one-line grep/diff rule |

- **Human:** reads Rule + Severity, fills Result + Notes
- **Agent:** runs Agent check column, auto-fills Result + Notes

**Result values:** `PASS` | `FAIL` | `N/A`  
**Severity values:** `BLOCKING` | `WARNING` | `INFO`

---

## Checklist Items (32 total)

### Section 1 — Skill structure (6 items)

| ID | Rule | Severity | Agent check |
|----|------|----------|-------------|
| SK-01 | New evaluation dimensions extend `torch-accelerator-readiness` via flags (`--security`, `--performance`, etc.), not new standalone skills | BLOCKING | PR adds `skills/<new-name>/` where `<new-name>` is a dimension of accelerator assessment |
| SK-02 | Flag syntax documented in `SKILL.md` with examples for default, single-dimension, and combined runs | BLOCKING | PR adds dimension but `SKILL.md` has no flag documentation |
| SK-03 | Default invocation (no flags) runs only base functional evaluation | BLOCKING | PR changes default to include new dimension without explicit flag |
| SK-04 | New standalone skill justified only for genuinely new framework (not a PyTorch dimension) | WARNING | PR adds `skills/` entry — confirm framework vs. dimension |
| SK-05 | Root `SKILL.md` and `skills/torch-accelerator-readiness/SKILL.md` stay in sync | BLOCKING | Diff touches one but not the other |
| SK-06 | Skill frontmatter `description` does not redirect to separate skill for related dimensions | BLOCKING | Description says "use `<other-skill>` instead" for a flag-eligible dimension |

**PR #16 mapping:** separate `torch-security-readiness` skill → fails SK-01, SK-02, SK-06.

**Correct pattern:**

```
/torch-air:torch-accelerator-readiness <backend>              # functional only (default)
/torch-air:torch-accelerator-readiness <backend> --security   # security only
/torch-air:torch-accelerator-readiness <backend> --all          # both
```

---

### Section 2 — Framework nesting (6 items)

| ID | Rule | Severity | Agent check |
|----|------|----------|-------------|
| FN-01 | Evaluation dimensions nest under parent framework, not as peer `frameworks/<dimension>/` | BLOCKING | PR adds `frameworks/security/`, `frameworks/performance/`, etc. at top level |
| FN-02 | Dimension path is `frameworks/<framework>/<dimension>/` with `checklist.md` + `EVAL.md` | BLOCKING | Dimension files not under parent framework directory |
| FN-03 | Framework-specific items stay scoped to that framework | BLOCKING | Checklist references PyTorch APIs but lives outside `frameworks/pytorch/` |
| FN-04 | New true frameworks get `frameworks/<name>/` with `checklist.md` + `EVAL.md` + dispatch entry | BLOCKING | New framework dir missing `EVAL.md` or `checklist.md` |
| FN-05 | `frameworks/review/` is meta — must not appear in functional dispatch table | BLOCKING | Dispatch table includes `frameworks/review/` |
| FN-06 | README repository tree reflects actual nesting | WARNING | README tree contradicts PR file layout |

**PR #16 mapping:** `frameworks/security/` as peer → fails FN-01, FN-02, FN-03.

**Correct pattern:**

```
frameworks/pytorch/
├── checklist.md
├── EVAL.md
└── security/
    ├── checklist.md
    └── EVAL.md
```

---

### Section 3 — Scoring consistency (7 items)

| ID | Rule | Severity | Agent check |
|----|------|----------|-------------|
| SC-01 | Every scored row uses numeric points: `0` / `1` / `2` / `N/A` | BLOCKING | Template uses only PASS/PARTIAL/FAIL or READY/CONDITIONAL/NOT READY |
| SC-02 | Overall readiness is weighted percentage, not qualitative-only verdict | BLOCKING | Template has overall verdict without percentage formula |
| SC-03 | Every scored row has pre-filled Priority (1=critical, 2=important, 3=nice-to-have) | BLOCKING | Checklist rows missing Priority column |
| SC-04 | Sections have Levels (1–3) with tier weighting `weight = 1/level` documented | BLOCKING | New checklist has sections but no level assignments |
| SC-05 | Scoring formulas match `frameworks/pytorch/checklist.md` model | BLOCKING | PR introduces different weight/priority formula without justification |
| SC-06 | Summary block at top: Executive Summary + Section Scores + overall % | BLOCKING | New checklist template missing summary block |
| SC-07 | Domain sub-scores roll up to section %, then overall % (no parallel systems) | WARNING | Template has domain PASS/FAIL and unrelated numeric score |

**PR #16 mapping:** PASS/PARTIAL/FAIL + READY/CONDITIONAL/NOT READY → fails SC-01, SC-02.

**Established scoring model (reference):**

```
Row weight:     w_i = 1 / priority_i
Section %:      sum(score_i * w_i) / sum(2 * w_i) * 100   (N/A rows excluded)
Tier weight:    weight_r = 1 / level
Overall %:      sum(section_pct * weight_r) / sum(weight_r) * 100
```

---

### Section 4 — Dispatch & orchestration (7 items)

| ID | Rule | Severity | Agent check |
|----|------|----------|-------------|
| DS-01 | Framework Dispatch table lists only true frameworks, not evaluation dimensions | BLOCKING | Dispatch row for Security/Performance as if a framework |
| DS-02 | Optional dimensions routed by flags in `SKILL.md`, not dispatch-table rows | BLOCKING | Dimension added to dispatch table instead of flag handling |
| DS-03 | Orchestrator does not run optional dimensions on default invocation | BLOCKING | "Follow all phases" without scoping to active flags |
| DS-04 | Combined evaluation requires explicit flag (e.g. `--all`) | BLOCKING | Dimensions run together by default without `--all` |
| DS-05 | Each dimension's `EVAL.md` loaded only when its flag is active | BLOCKING | EVAL.md reference unconditional for optional dimension |
| DS-06 | Output naming: `torch-air-report/<type>_report_<backend>.md` | WARNING | New report path breaks convention |
| DS-07 | Dimension phases don't pollute base `frameworks/pytorch/EVAL.md` | WARNING | Functional EVAL.md grows with unrelated dimension phases |

**PR #16 mapping:** Security dispatch row + "follow all phases" → fails DS-01, DS-02, DS-03.

---

### Section 5 — General conventions (6 items)

| ID | Rule | Severity | Agent check |
|----|------|----------|-------------|
| GC-01 | Generated reports target `torch-air-report/` (git-ignored) | WARNING | Output path outside `torch-air-report/` |
| GC-02 | README updated when assessment surface changes | WARNING | PR touches `frameworks/` or `skills/` but not README |
| GC-03 | EVAL.md includes ground rule: strip internal instructions from generated reports | WARNING | New EVAL.md missing "no meta-content in output" rule |
| GC-04 | `plugin.json` skills path remains `./skills/` | WARNING | plugin.json changed incorrectly |
| GC-05 | Checklist preserves table structure; only row content changes during refinement | INFO | PR restructures section numbering or column layout |
| GC-06 | Checklist rows include evidence column (Notes/Evidence) with citation format | WARNING | Rows lack evidence/notes column |

---

## Verdict Logic

| Condition | Verdict |
|-----------|---------|
| Any BLOCKING item = FAIL | **CHANGES_REQUESTED** |
| ≥3 WARNING items = FAIL | **CHANGES_REQUESTED** |
| All BLOCKING = PASS, ≤2 WARNING failures | **APPROVE** (with advisory notes) |
| PR type = `orchestrator-change` only | FN/SC sections may be N/A where not applicable |

---

## PR #16 Walkthrough (validation)

If this checklist had been applied to PR #16:

| Item | Result | Reason |
|------|--------|--------|
| SK-01 | FAIL | Added `skills/torch-security-readiness/` |
| SK-02 | FAIL | No `--security` / `--all` flags documented |
| SK-06 | FAIL | Functional skill redirects to security skill |
| FN-01 | FAIL | `frameworks/security/` at peer level |
| FN-02 | FAIL | Not under `frameworks/pytorch/` |
| SC-01 | FAIL | PASS/PARTIAL/FAIL scoring |
| SC-02 | FAIL | READY/CONDITIONAL/NOT READY verdict |
| DS-01 | FAIL | Security row in dispatch table |
| DS-03 | FAIL | "Follow all phases" would trigger security on functional run |

**Verdict:** CHANGES_REQUESTED (matches actual review outcome).

---

## Out of Scope (deferred)

- `frameworks/review/EVAL.md` — agent orchestration workflow
- `skills/pr-architecture-review/SKILL.md` — review agent skill
- GitHub Actions integration
- Automated PR comment posting
- Learning from human review feedback

---

## Implementation Plan (next step)

After spec approval, invoke `writing-plans` skill to create an implementation plan for:

1. Create `frameworks/review/checklist.md` from this spec (fillable template with all 32 rows)
2. Update README repository structure tree
3. Add brief pointer in README to the architecture review checklist

No review agent or `EVAL.md` in the first implementation pass.
