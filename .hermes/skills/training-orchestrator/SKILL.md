---
name: training-orchestrator
description: Continue and coordinate work in this Semantic Training Interpreter repository with low context cost; use for test protocol, Gemma prompt evaluation, data-flow diagnosis, and Hermes delegation.
version: 1.0.0
metadata:
  hermes:
    tags: [project, testing, orchestration, context]
    category: development
---

# Training Project Orchestrator

Use this project skill when coordinating tests, prompt evaluation, or bug diagnosis in this repository. It is intentionally short; load detailed references only when needed.

## First read

1. `AGENTS.md` for invariants and repository rules.
2. `docs/ORCHESTRATOR_HANDOFF.md` for current user decisions, working-tree cautions, and next steps.
3. For test design or test work, read `docs/testing/TESTING_PROTOCOL.md` and `docs/testing/TEST_MATRIX.md`. For the live Obsidian acceptance sequence, run `docs/testing/OBSIDIAN_ACCEPTANCE_RUNBOOK.md` and fill `EXECUTION_REPORT_TEMPLATE.md`.
4. Before semantic data-flow work, read the specific user artifact and case spec that governs it.

Do not load the whole archive, every prompt-lab response, or unrelated docs by default. Search narrowly with `rg`; open only matching source files and their tests.

## Keep model calls cheap and useful

- Treat Gemma 4 on the project's configured runtime as the target under evaluation. Do not substitute Hermes/OpenRouter model output for Gemma evidence.
- Delegate only a bounded, independent task. Include exact inputs, relevant files, constraints, output shape, and completion criteria. Do not ask a small model to rediscover the repository or infer user intent.
- Keep one source-of-truth handoff instead of pasting long prior transcripts into every task. Link to it and add only the task-specific delta.
- Separate facts, user-approved expectations, hypotheses, and unresolved questions in notes.
- Stop at contradictions in user-owned instructions and ask the user; do not resolve them autonomously.
- Preserve all existing working-tree changes. Before editing a target, inspect its current diff.

## Evidence and completion

- Trace the first stage where actual output diverges from the user-approved expectation.
- Distinguish LLM quality, module contract, inter-stage data flow, UI/staging/persistence, and build/runtime issues.
- A present test file is not evidence that its test passed. Report what was inspected, run, or manually confirmed.
- After changing prompts or relevant runtime sources, follow repository build and guard instructions. Do not modify user-approved prompt semantics without the required review.

## Detailed guidance (load only when relevant)

- Test scope, test oracles, trace requirements, model repetition, canvas choice: `docs/testing/TESTING_PROTOCOL.md`.
- Existing per-stage checks and gaps: `docs/testing/TEST_MATRIX.md`.
- Copyable live-Vault procedure and seeds: `docs/testing/OBSIDIAN_ACCEPTANCE_RUNBOOK.md`, fixtures `TC-001-empty-state/` and `TC-002-after-TC-001/`; the latter is built by `node tools/prepare_tc002_seed.js`.
- Validate handoff links, the 20-row matrix, Canvas node IDs, seed contents, and both SHA-256 manifests with `node tools/check_test_docs.js`.
- User decisions and resumable project state: `docs/ORCHESTRATOR_HANDOFF.md`.
