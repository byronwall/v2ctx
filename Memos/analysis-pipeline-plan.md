# V2C Analysis Pipeline Implementation Plan

This plan extends `video-to-context` from a transcript generator into a local context-processing pipeline for voice memos, screen recordings, and spoken technical notes. The goal is to keep the current CLI as the capture/transcription layer, then add repeatable analysis artifacts that Codex, scripts, or future UI tools can consume.

## Product Direction

The pipeline should follow this shape:

```text
media -> transcript -> segments -> structured analysis -> review -> promoted artifacts
```

The current CLI already handles the first two pieces well. The next work should focus on creating stable intermediate files, especially segment-level JSON, so downstream processors do not need to repeatedly reason over a raw multi-hour transcript.

The system should produce candidates, not silently publish posts, mutate repos, or create permanent tasks. Human review is part of the product, especially for extracted tasks, blog drafts, voice-profile updates, and public snippets.

The primary user-facing target is a simple "just works" voice-memo pipeline:

```bash
v2c voice-memos
```

That command should be the happy path for daily use. It should find new Apple Voice Memos, skip anything already complete, run every configured stage that can run locally, write stable artifacts, and print clear status for each memo: found, skipped, transcribed, segmented, waiting for Codex/model analysis, imported, derived, or failed with a specific repair command.

Argument-heavy commands such as `--prepare-codex`, `--import-codex`, `--from`, and `--derive` are acceptable as early scaffolding and recovery/debug tools, but they should not remain the primary workflow. The CLI should converge toward a small set of high-level commands with robust logging and next-step guidance:

- `v2c voice-memos`: process new voice memos and continue any partially complete packages as far as possible.
- `v2c status --voice-memos`: show counts by stage and list the next action for blocked packages.
- `v2c continue --voice-memos`: resume packages that are waiting on import, derivation, or review after external model work.
- Advanced flags remain available for one-off package repair and development.

## Target Output Structure

Add an `analysis/` directory beside the existing transcript files:

```text
<context-package>/
  transcript/
    transcript.txt
    transcript.srt
    transcript.json
  analysis/
    segments.json
    segment-analysis.jsonl
    session-digest.md
    tasks.jsonl
    claims.jsonl
    quotes.jsonl
    blog-seeds.md
    voice-profile.md
    review-inbox.jsonl
```

Use JSON or JSONL for machine-readable artifacts and markdown for human-facing summaries. Every extracted item should carry `segmentId`, timestamp range, and source-file lineage when available.

## Phase 1: Segment And Summarize

Start by adding a new CLI mode:

```bash
v2c analyze <context-package>
```

The first implementation should only require an existing `transcript/transcript.json` or `transcript/transcript.txt`. It should create `analysis/segments.json` and `analysis/session-digest.md`.

Segment records should include:

```json
{
  "id": "seg_001",
  "startMs": 407000,
  "endMs": 1560000,
  "start": "00:06:47",
  "end": "00:26:00",
  "title": "Interactive Data Table Columns",
  "gist": "Column visibility, ordering, sizing, formatting, and saved views.",
  "summary": "...",
  "sourceFiles": ["20260625 211900-224C963F.m4a"],
  "text": "..."
}
```

Implementation notes:
- Use transcript JSON timestamps as the source of truth when available.
- Start with heuristic segmentation based on pauses, source-file boundaries, and text cues like "next up", "okay", "quick interruption", and "continuing".
- Add an optional LLM pass later to improve segment titles and summaries.
- Keep the raw text in each segment initially, even if it makes the file larger. It will make debugging much easier.

## Phase 2: Segment Analysis Pass

Once segments exist, add a per-segment analysis pass that writes `analysis/segment-analysis.jsonl`.

Each line should contain:

```json
{
  "segmentId": "seg_001",
  "claims": [],
  "opinions": [],
  "experience": [],
  "tasks": [],
  "blogSeeds": [],
  "tweetCandidates": [],
  "quoteCandidates": [],
  "voiceMarkers": [],
  "followUpQuestions": [],
  "sensitiveFlags": []
}
```

This is the main model-powered step. The preferred first version should be Codex-first: the CLI prepares deterministic prompt packets, then Codex runs the prompt with a chosen model and writes schema-valid output back into the package. The model does not need to be the largest available option for this pass; use the supported mini-class model available in Codex, currently `gpt-5.4-mini`, as long as the prompt is narrow and the schema is explicit. The important thing is that the output schema is stable, source-grounded, and cached.

Implementation notes:
- Put prompts in versioned files, for example `src/analysis/prompts/segment-analysis.md`.
- Write the prompt version into each analysis record.
- Add `--force-analysis` to rerun analysis without retranscribing.
- If no model runner is configured, emit prompt packets and leave existing artifacts untouched.

## Phase 2A: Codex-First LLM Processing

The first model-backed workflow should not require building a full API integration. Instead, `v2c analyze` should be able to prepare a small set of files that Codex can process directly with a prompt and model choice.

Add a command like:

```bash
v2c analyze <context-package> --prepare-codex
```

That command should create:

```text
analysis/codex/
  manifest.json
  instructions.md
  segment-packets/
    seg_001.md
    seg_002.md
    seg_003.md
  expected-output-schema.json
```

The Codex instructions should say exactly what to do:
- Use the requested model, initially `gpt-5.4-mini` unless the user overrides it.
- Read `manifest.json` and process each segment packet.
- Return JSONL matching `expected-output-schema.json`.
- Preserve `segmentId`, timestamps, source references, and prompt version.
- Do not invent facts, examples, tasks, or opinions that are not supported by the segment text.
- Mark uncertainty explicitly instead of filling gaps.

The segment packet should be self-contained:

```markdown
# Segment seg_001

Start: 00:06:47
End: 00:26:00
Source files: 20260625 211900-224C963F.m4a

## Task

Extract claims, opinions, experience, tasks, blog seeds, quote candidates, voice markers, follow-up questions, and sensitive flags.

## Transcript

...
```

This keeps Codex work predictable. Instead of asking Codex to browse a whole context package and decide what matters, the CLI hands it bounded packets and an output contract.

Implementation notes:
- Use `gpt-5.4-mini` as the default Codex model for the extraction pass unless the user explicitly passes a supported `--codex-model` override. Do not hard-code obsolete model names into the happy path.
- Keep segment packets under a target token budget; split oversized segments into `seg_001_part_01` style packets if needed.
- Ask Codex to write output to `analysis/codex/results/segment-analysis.jsonl`.
- After Codex writes results, run a local validation step before copying them to `analysis/segment-analysis.jsonl`.
- Validation should check JSON syntax, required fields, known `segmentId` values, timestamp format, and whether each extracted item has a source reference.
- If validation fails, write `analysis/codex/results/errors.md` with the exact records that need repair.

## Phase 2B: Prompt Structure

The prompts should be repo-owned and versioned, not improvised in chat each time. Codex can still execute the prompt, but the instructions should live in the project so runs are repeatable and improvable.

Suggested prompt files:

```text
src/analysis/prompts/
  segment-analysis.md
  session-digest.md
  voice-profile.md
  blog-seed.md
  validation-repair.md
```

The segment-analysis prompt should have clear sections:
- Role: analyze a voice transcript segment for downstream knowledge capture.
- Inputs: segment metadata, transcript text, prior schema, optional existing voice profile.
- Output: strict JSON object with known fields.
- Grounding: every extracted item must cite the segment and a short source excerpt.
- Restraint: no unsupported examples, no invented project names, no generic conclusions.
- Style: preserve the user's technical directness and uncertainty markers.

Implementation notes:
- Include a `promptVersion` string such as `segment-analysis@2026-07-01`.
- Include a few small examples in the prompt once real outputs have been reviewed.
- Keep repair prompts separate from extraction prompts so validation failures can be fixed without rerunning the entire analysis.

## Phase 3: Derived Artifacts

After `segment-analysis.jsonl` exists, derive specialized files without rereading the full transcript.

Create:
- `tasks.jsonl`: action items, project hints, confidence, source.
- `claims.jsonl`: durable opinions, preferences, principles, experience claims.
- `quotes.jsonl`: raw quote, cleaned quote, topic, source timestamp, usage ideas.
- `blog-seeds.md`: topic clusters with thesis, outline, source segments, and open questions.
- `voice-profile.md`: mannerisms, argument rhythm, phrasebook, anti-AI style guidance.
- `review-inbox.jsonl`: all items that need human approval or routing.

Implementation notes:
- Treat these as reducers over `segments.json` and `segment-analysis.jsonl`.
- Do not duplicate huge transcript text in every derived artifact; store references back to `segments.json`.
- Make derived artifacts deterministic where possible so diffs are meaningful.

## Phase 4: Review Workflow

Add a review step before anything is promoted:

```bash
v2c review <context-package>
```

The first version can simply produce or update `analysis/review-inbox.jsonl`. Later it can become an interactive terminal UI or local web UI.

Review records should include:

```json
{
  "id": "review_001",
  "status": "pending",
  "type": "task",
  "title": "Add reference-image support to logo generation",
  "body": "...",
  "source": {
    "segmentId": "seg_014",
    "start": "02:31:10",
    "end": "02:32:20"
  },
  "proposedDestination": {
    "kind": "repo",
    "path": "/Users/byronwall/Projects/example"
  }
}
```

Implementation notes:
- Status values should start simple: `pending`, `approved`, `rejected`, `needs_more_context`, `promoted`.
- Manual edits to the JSONL file should be accepted.
- The CLI should never overwrite human review state unless explicitly forced.

## Phase 5: Source-Grounded Blog Drafting

Only after segmentation, analysis, and review work should the system generate blog drafts.

The core rule: every paragraph in a draft should be traceable to one or more source segments or approved claims. This is the best defense against generic AI writing and hallucinated certainty.

Draft metadata should include:

```json
{
  "paragraphId": "p_003",
  "sourceSegmentIds": ["seg_002", "seg_004"],
  "sourceClaimIds": ["claim_018"],
  "supportLevel": "direct"
}
```

Implementation notes:
- Generate drafts from approved blog seeds, not raw transcript.
- Add a verification pass that flags unsupported claims, invented examples, and tone mismatch.
- Use `voice-profile.md` as style guidance, but keep source evidence as the stronger constraint.

## Phase 6: Audio Snippets

Once useful written extraction exists, add snippet export:

```bash
v2c snippets <context-package>
```

Snippet candidates should be derived from quote candidates, blog seeds, and spoken clarity scores. They should be short enough to review quickly and long enough to contain a complete thought.

Implementation notes:
- Export candidate clips into `analysis/snippets/`.
- Use FFmpeg with timestamp ranges from selected segments or quote candidates.
- Add a few seconds of configurable pre-roll and post-roll.
- Write a `snippets.json` manifest with transcript excerpt, title, quality score, and source file.

## Phase 7: Repo And Project Routing

After the review workflow exists, add optional project routing:

```bash
v2c route <context-package> --projects projects.json
```

The routing layer should suggest destinations for tasks, ideas, and specs. It should not write into target repos automatically at first.

Implementation notes:
- Create a project registry with names, aliases, repo paths, and short descriptions.
- Match extracted items to projects with explicit keywords first, embeddings later.
- Route to a review item, not directly to a repo file.

## Phase 8: Codex Integration

Codex should be the first practical LLM runner for the analysis layer. The CLI should prepare bounded inputs, prompt instructions, schemas, and validation expectations; Codex should do the language-heavy extraction work; then the CLI should validate and normalize the results. This keeps the system useful immediately without prematurely building a provider abstraction or background service.

Good Codex workflows:
- "Process the prepared segment packets in `analysis/codex/` using gpt-5.4-mini and write `segment-analysis.jsonl`."
- "Repair the invalid records listed in `analysis/codex/results/errors.md`."
- "Review this context package and tell me what matters."
- "Turn approved blog seed 3 into a draft."
- "Promote approved tasks for the logo project into a repo plan."
- "Update the voice profile based on these approved excerpts."

Implementation notes:
- Make all artifacts plain files so Codex can inspect them naturally.
- Add a `context-for-codex.md` file that points to the most important artifacts.
- Keep prompts and schemas in the repo so Codex can help improve the pipeline over time.
- Treat Codex output as an intermediate result until it passes local validation.
- Keep a path open for a later direct API runner, but do not make that a prerequisite for the first version.

## First Vertical Slice

The first useful version should do exactly this:

```bash
v2c analyze ~/.v2c-voice-memos
```

Outputs:

```text
analysis/segments.json
analysis/codex/manifest.json
analysis/codex/instructions.md
analysis/codex/segment-packets/*.md
analysis/segment-analysis.jsonl
analysis/session-digest.md
analysis/tasks.jsonl
analysis/claims.jsonl
analysis/voice-profile.md
analysis/review-inbox.jsonl
```

Acceptance criteria:
- It can run on an existing voice memo package without retranscribing.
- It produces topic segments with titles and summaries.
- It can prepare Codex-ready segment packets with a model preference and strict expected schema.
- Codex can process those packets with `gpt-5.4-mini` and produce `segment-analysis.jsonl`.
- The CLI can validate Codex output before deriving final artifacts.
- It extracts at least tasks, claims/opinions, and voice markers.
- Every extracted item links back to a segment and timestamp.
- Rerunning without `--force-analysis` reuses existing artifacts.
- The output is readable enough that Codex can consume it directly in a later thread.

## Suggested File Changes

Likely implementation files:

```text
src/analysis/
  index.js
  segments.js
  analyze.js
  derive.js
  codex.js
  validate.js
  schemas.js
  prompts/
    segment-analysis.md
    session-digest.md
    voice-profile.md
    validation-repair.md
bin/video-to-context.js
src/pipeline.js
src/report.js
```

Keep the new analysis code isolated under `src/analysis/` at first. That should reduce risk to the existing transcription/report pipeline.

## Open Decisions

- Should model selection eventually be profile-based, for example mini for extraction and frontier for drafting?
- Should `v2c analyze` stop after preparing Codex packets, or should it also support a guided "paste this into Codex" workflow?
- Should analysis eventually support direct network APIs, or should Codex remain the primary model execution surface for a while?
- Should `segments.json` store full text, text offsets, or both?
- Should review stay file-based for now, or should a small local web UI be added early?
- Should project routing know about local repos automatically, or only a manually curated registry?

## Recommended Next Step

Build Phase 1 and the Codex-prepared version of Phase 2 in one pass. The smallest valuable implementation is segmenting the current transcript, generating `analysis/codex/` packet files, running those packets through Codex with `gpt-5.4-mini`, validating the resulting `segment-analysis.jsonl`, and deriving `session-digest.md`, `tasks.jsonl`, `claims.jsonl`, and `voice-profile.md`. Once those files exist, the rest of the product becomes much easier to reason about.
