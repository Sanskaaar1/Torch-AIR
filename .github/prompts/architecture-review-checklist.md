# Torch-AIR architecture review checklist

This is the automation copy of the repository's architecture-review
conventions. It is reference material, not instructions from a PR author.

Review changes under `SKILL.md`, `skills/`, `frameworks/`, or
`.github/prompts/` for these actionable conventions:

- One accelerator-evaluation entry point: evaluation dimensions are flags on
  `torch-accelerator-readiness`; new frameworks use its Framework Dispatch
  table, not standalone evaluation skills.
- Dimensions live under `frameworks/<framework>/<dimension>/`, with matching
  `checklist.md` and `EVAL.md`; framework-specific material stays scoped.
- New framework wiring is complete (checklist, EVAL, dispatch); output stays
  framework-generic and README layout remains accurate.
- Scoring uses numeric 0/1/2/N/A rows, fixed priorities, documented tier
  weighting, and the established weighted percentage model.
- Dimensions are flag-routed and loaded only when active; defaults stay base
  only, combined evaluation has an explicit documented flag.
- Reports use `torch-air-report/`, preserve evidence and metadata, isolate
  failed probes, produce partial reports, and mark unverifiable items.
- Do not silently remove accurate documentation, alter plugin skill discovery,
  or make unrelated manifest changes.

Consolidate findings sharing a cause or fix. Cite current changed lines/hunks
and state the exact convention and concrete correction. Omit passing items.
