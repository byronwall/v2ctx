# Voice Memos Pipeline Speed Plan

This plan focuses on the primary daily workflow:

```bash
v2c voice-memos
```

The target is a CLI that processes new Apple Voice Memos, resumes partial packages, runs Codex analysis when needed, derives review artifacts, and prints exactly what happened and what remains.

## Current Observed State

Filesystem inspection of `/Users/byronwall/.v2c-voice-memos` showed 18 per-memo context packages:

- 16 packages are fully derived.
- 1 package has a misplaced Codex result at `results/segment-analysis.jsonl` instead of `analysis/codex/results/segment-analysis.jsonl`.
- 1 package is still waiting for Codex/model analysis.

Current package stages:

```text
derived:          16
misplaced_result:  1
waiting_codex:     1
```

The run has mostly worked, but the workflow still has avoidable drag:

- Codex calls are serial.
- Each package launches a fresh Codex session.
- Misplaced outputs still happen and require repair logic.
- Logs expose too much raw Codex failure text and not enough summarized stage progress.
- The CLI does not yet show an ETA, per-stage duration, or throughput.

## Goals

1. Keep `v2c voice-memos` as the single happy-path command.
2. Make repeated runs cheap: skip complete packages and resume partial packages.
3. Avoid re-transcribing, re-segmenting, or re-running Codex when valid artifacts already exist.
4. Reduce model overhead by batching work where safe.
5. Make status legible: every package should show a stage, next action, and last error if any.
6. Keep all intermediate artifacts plain files for inspection and repair.

## Phase 1: Fix Workflow Correctness Before Speed

### Add `v2c voice-memos --status`

Print a compact table without doing work:

```text
Package                                Stage             Segments  Next
20260625-213831-3CAE708B-context       misplaced_result  1         import misplaced result
20260701-074611-8BF6FFF9-context       waiting_codex     3         run codex
...
```

Include totals:

```text
derived: 16
waiting_codex: 1
misplaced_result: 1
failed: 0
```

### Auto-repair misplaced Codex output

If a package has:

```text
results/segment-analysis.jsonl
```

but lacks:

```text
analysis/segment-analysis.jsonl
analysis/codex/results/segment-analysis.jsonl
```

then validate the misplaced file against `analysis/codex/manifest.json`, import it, derive artifacts, and log:

```text
repaired misplaced Codex result
```

This removes a common manual-copy failure mode.

### Persist stage metadata

Write a small package-local state file:

```text
analysis/pipeline-state.json
```

Suggested fields:

```json
{
  "stage": "derived",
  "updatedAt": "2026-07-02T04:35:00Z",
  "lastAction": "derive",
  "lastError": null,
  "durationsMs": {
    "transcribe": 12345,
    "segment": 42,
    "codex": 183000,
    "import": 12,
    "derive": 28
  }
}
```

The filesystem should remain the source of truth, but this file makes logs and status faster and clearer.

## Phase 2: Make Codex Work Faster

The slowest part is likely repeated Codex process/session startup plus model inference. Improve that before touching transcription.

### Batch small packages into one Codex run

Instead of one Codex invocation per package, create a batch directory:

```text
~/.v2c-voice-memos/.codex-batches/<timestamp>/
  manifest.json
  instructions.md
  packages/
    20260625-213831-3CAE708B-context/
      segment-packets/*.md
      expected-output-schema.json
    20260701-074611-8BF6FFF9-context/
      segment-packets/*.md
      expected-output-schema.json
  results/
    20260625-213831-3CAE708B-context/segment-analysis.jsonl
    20260701-074611-8BF6FFF9-context/segment-analysis.jsonl
```

Batch only packages whose combined packet text is below a conservative token budget.

Benefits:

- fewer Codex process startups
- fewer skill/config load warnings
- less repeated instruction overhead
- simpler progress for small memos

### Add controlled concurrency

For packages too large to batch, run Codex with a small concurrency limit:

```bash
v2c voice-memos --codex-concurrency 2
```

Default should be conservative:

```text
codex-concurrency: 1
```

Move to `2` only after the single-package flow is stable. Avoid aggressive concurrency because Codex sessions are expensive and error output can become unreadable.

### Avoid rerunning Codex unnecessarily

Before running Codex, validate these cache keys:

- `analysis/codex/manifest.json`
- all packet file names and mtimes
- `expected-output-schema.json`
- prompt version
- selected model

If `analysis/segment-analysis.jsonl` already validates against the current manifest, skip Codex.

If `analysis/codex/results/segment-analysis.jsonl` exists but has not been imported, import it.

## Phase 3: Improve Prompt Packet Efficiency

### Split only oversized segments

Current segments can be large. Add packet splitting only when needed:

```text
seg_008_part_01.md
seg_008_part_02.md
```

Then merge results back to the parent segment or allow part IDs in the schema. Do not split short voice memos; that increases overhead.

### Reduce repeated schema text

Keep schema in `expected-output-schema.json`. Segment packets should reference the schema rather than repeating long instructions. The batch-level `instructions.md` should hold shared guidance once.

### Use a compact extraction schema

Keep extracted item shape small:

```json
{
  "text": "...",
  "excerpt": "...",
  "uncertainty": false
}
```

Avoid asking for outlines, drafts, or routing decisions in the first model pass. Derive and route later.

## Phase 4: Make Transcription Faster

Transcription is already cached by package, so optimize it after Codex batching.

### Skip audio extraction when package is complete

Do not call FFmpeg or whisper when a package is already at `derived` unless `--force` is passed.

### Check source fingerprint before transcribing

For each single-memo package, compare source file path, size, and mtime to `.v2c-manifest.json`. If unchanged and transcript exists, skip all capture work.

### Consider model presets

Add clear presets:

```bash
v2c voice-memos --fast
v2c voice-memos --accurate
```

Potential mapping:

```text
--fast:     whisper base.en, Codex gpt-5.4-mini
--accurate: whisper medium.en, Codex gpt-5.4-mini
```

Do not make users remember both Whisper and Codex model flags for daily use.

## Phase 5: Better Logging

Replace raw repeated logs with stage summaries:

```text
› Voice memo pipeline
  found 18 memo file(s)
  complete: 16
  repaired: 1
  codex queued: 1

› 20260701-074611-8BF6FFF9-context
  stage: waiting_codex
  segments: 3
  model: gpt-5.4-mini
  action: running Codex
  ✓ Codex wrote 3 records in 42s
  ✓ Derived 12 review items
```

On failure:

```text
! 20260701-074611-8BF6FFF9-context failed at codex
  reason: unsupported model gpt-5-mini
  fix: rerun with v2c voice-memos --force-analysis
```

Do not stream full Codex stderr for every package by default. Save it to:

```text
analysis/codex/results/codex.log
```

Print only the summarized reason.

## Phase 6: Commands To Add

### Status

```bash
v2c voice-memos --status
```

No writes. Shows package stages and next actions.

### Continue

```bash
v2c voice-memos --continue
```

Only resumes packages not at `derived`. This can become the default behavior once stable.

### Repair

```bash
v2c voice-memos --repair
```

Runs safe repairs:

- import misplaced Codex results
- derive artifacts from existing valid segment analysis
- rewrite stale `preferredModel` values in Codex manifests

### Performance Debug

```bash
v2c voice-memos --timings
```

Prints per-stage durations from `analysis/pipeline-state.json`.

## Near-Term Implementation Order

1. Add status detection and `--status`.
2. Add misplaced-result auto-repair.
3. Write `analysis/pipeline-state.json` with durations and last errors.
4. Suppress repeated raw Codex stderr; save it to a log file.
5. Add `--repair`.
6. Add small-package Codex batching.
7. Add `--codex-concurrency` after batching is reliable.
8. Add `--fast` and `--accurate` presets.

## Success Criteria

The daily flow should look like this:

```bash
v2c voice-memos
```

And the output should answer:

- How many memo files were found?
- How many packages were already complete?
- Which packages advanced?
- Which packages are waiting?
- Which package failed, at what stage, and what command fixes it?
- How long did transcription, Codex, import, and derivation take?

The user should not need to copy JSONL files, inspect package folders, or remember internal flags during the normal workflow.
