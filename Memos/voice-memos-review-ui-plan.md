# Voice Memos Review UI Plan

The current pipeline can produce per-memo analysis artifacts, but the next product step is not more JSON. The next step is a local review interface that makes extracted tasks, claims, quotes, and blog seeds easy to inspect, trust, approve, reject, and route.

The target experience:

```bash
v2c voice-memos --ui
```

or:

```bash
v2c review --voice-memos
```

That command should start a local web server, open a browser, and show a review inbox backed by the completed voice memo packages in:

```text
~/.v2c-voice-memos
```

## Product Goal

The UI should answer three questions quickly:

1. What did the pipeline find?
2. Why should I trust that extraction?
3. What should happen to it?

Every review item should show the concrete extracted thing and the evidence behind it:

- the extracted task, claim, quote, blog seed, or sensitive flag
- the source memo package
- segment timestamp range
- the supporting source excerpt
- nearby transcript context
- ideally playable audio clipped to the relevant time range

The UI should make review feel like triage, not file spelunking.

## Primary Screens

### 1. Inbox

A dense review table/list of all extracted items across all packages.

Columns or visible fields:

- status: pending, approved, rejected, needs context, routed
- type: task, claim, quote, blog seed, sensitive flag
- title/text
- source memo date/name
- confidence or uncertainty marker
- project/routing hint if available
- reviewed timestamp

Default filters:

- pending only
- newest first
- group by memo

Useful filters:

- type
- status
- source package
- uncertain only
- has sensitive flag
- search text
- date range
- project hint

Bulk actions:

- approve selected
- reject selected
- mark needs context
- export selected

The inbox should avoid huge cards. This is operational review work; the UI should be compact and scannable.

### 2. Review Detail

Selecting an item opens a detail pane beside the inbox.

Detail pane sections:

```text
Extracted item
Evidence
Transcript context
Audio
Actions
Routing
Metadata
```

#### Extracted Item

Show the cleaned extracted text prominently, with editable fields:

- title/text
- type
- uncertainty flag
- notes

#### Evidence

Show the model-provided source excerpt and segment metadata:

```text
Segment: seg_004
Time: 00:08:30 - 00:10:47
Source: 20260701 182553-469ECCA2.m4a
```

#### Transcript Context

Show the relevant transcript segment with the supporting excerpt highlighted.

Minimum version:

- display full segment text from `analysis/segments.json`
- highlight `item.excerpt` with simple substring matching when possible
- include previous/next segment buttons

Better version:

- show transcript lines with timestamps from `transcript/transcript.json`
- scroll directly to the line range that overlaps the extracted item
- allow expanding context by 30 seconds before/after

#### Audio

Best version:

- play the original audio around the source range
- default clip range: segment start minus 5 seconds to segment end plus 5 seconds
- show waveform or simple scrubber
- jump buttons: excerpt, segment start, segment end

Fallback version:

- play `audio/audio.wav` from the context package with a start time
- if browser range seeking works, use `audio.currentTime = startSeconds`
- no separate clipping required

Optional generated clip:

```text
analysis/clips/review_0001.wav
```

Generate only on demand using FFmpeg so the pipeline does not create hundreds of tiny files eagerly.

### 3. Source Memo View

A page for one context package:

- report link
- transcript summary
- segment list
- extracted items grouped by segment
- audio player for the whole memo
- analysis artifact links

This gives a coherent view when one memo is a long brainstorming session.

### 4. Queue / Pipeline Status

Show processing state for all packages:

- new
- transcribed
- segments ready
- waiting for Codex
- Codex result ready to import
- analysis ready
- derived
- failed

Include:

- package name
- source memo
- duration
- segment count
- review item count
- last error
- next action button

This replaces confusing terminal-only status output.

## Local Server

Add a small local web server command:

```bash
v2c review --voice-memos
```

or:

```bash
v2c voice-memos --ui
```

Server responsibilities:

- read package folders under `~/.v2c-voice-memos`
- aggregate review items
- serve static UI assets
- serve audio files with range requests
- expose JSON endpoints for packages, items, segments, and status
- write review status updates back to JSONL or a sidecar state file
- optionally run repair/import/derive actions

Avoid a database at first. Plain files are already the product.

## Suggested Server Stack

Keep dependencies minimal:

- Node built-in `http` server for first version, or a tiny dependency if the repo already has one later
- plain HTML/CSS/JS served from `src/review-ui/`
- no build step for the first version

Possible structure:

```text
src/review/
  server.js
  data.js
  audio.js
  actions.js
  public/
    index.html
    app.js
    style.css
```

Later, if the UI grows:

- move to Vite or a small React/Solid app
- add virtualized lists
- add keyboard shortcuts

Do not start with a large app framework unless the UI complexity demands it.

## Data Aggregation

On startup, scan:

```text
~/.v2c-voice-memos/*-context/analysis/review-inbox.jsonl
```

Each item should be normalized into a UI record:

```json
{
  "globalId": "20260701-182553-469ECCA2-context:review_0008",
  "packageId": "20260701-182553-469ECCA2-context",
  "packagePath": "/Users/byronwall/.v2c-voice-memos/20260701-182553-469ECCA2-context",
  "status": "pending",
  "type": "task",
  "title": "Build an iOS app flow that can record audio...",
  "body": "...",
  "source": {
    "segmentId": "seg_008",
    "start": "00:20:57",
    "end": "00:35:16",
    "sourceFiles": ["20260701 182553-469ECCA2.m4a"]
  },
  "excerpt": "I need to be able to record in the iOS app",
  "uncertainty": false
}
```

Also load:

```text
analysis/segments.json
transcript/transcript.json
.v2c-manifest.json
```

Use these to resolve:

- full segment text
- source file lineage
- local audio time
- source memo path
- package duration

## Review State Writes

Do not overwrite model output directly on every click. Use a sidecar state file:

```text
analysis/review-state.json
```

Example:

```json
{
  "review_0008": {
    "status": "approved",
    "notes": "Good task, route to notes app project",
    "updatedAt": "2026-07-02T05:00:00Z",
    "destination": {
      "kind": "project",
      "id": "notes-site"
    }
  }
}
```

At render time, merge `review-inbox.jsonl` with `review-state.json`.

Benefits:

- model output stays immutable
- manual review state is easy to preserve
- re-deriving artifacts does not wipe decisions
- status updates are small JSON writes

Later, add an explicit command:

```bash
v2c review export --voice-memos
```

to write approved/routed outputs.

## API Endpoints

Minimal endpoints:

```text
GET  /api/status
GET  /api/items?status=pending&type=task&q=...
GET  /api/items/:globalId
GET  /api/packages
GET  /api/packages/:packageId
GET  /api/packages/:packageId/segments/:segmentId
GET  /api/packages/:packageId/audio
POST /api/items/:globalId/status
POST /api/items/:globalId/notes
POST /api/items/:globalId/route
POST /api/packages/:packageId/actions/continue
POST /api/packages/:packageId/actions/repair
```

Audio endpoint:

```text
GET /api/packages/:packageId/audio
```

Should serve:

```text
<package>/audio/audio.wav
```

with HTTP range support. Browser audio seeking depends on range support for good UX.

Optional clip endpoint:

```text
GET /api/packages/:packageId/clips/:segmentId.wav?pad=5
```

Generate with FFmpeg on demand and cache in:

```text
analysis/clips/
```

## UI Interactions

### Keyboard Shortcuts

Useful triage shortcuts:

```text
j / k       next / previous item
a           approve
r           reject
n           needs context
e           edit title/text
space       play/pause audio
left/right  seek audio
f           focus search
```

### Status Buttons

Each item should have obvious actions:

- Approve
- Reject
- Needs Context
- Route
- Copy text
- Copy source reference
- Open package report

### Routing

Routing should start as metadata, not automatic repo mutation.

Possible destinations:

- project
- repo
- blog
- notes
- later
- discard

The first UI can use free text for destination. Later, add a project registry:

```text
~/.v2c-voice-memos/projects.json
```

or repo-owned config.

## Visual Design

This is a workbench, not a marketing page.

Layout:

```text
top bar: status counts, search, filters
left: item list
right: detail/evidence/audio pane
bottom or side: pipeline/status drawer
```

Design principles:

- compact rows
- strong status labels
- readable transcript text
- evidence always near extracted item
- avoid nested cards
- use monospace for timestamps and file paths
- make keyboard use comfortable

## First Vertical Slice

Build the smallest useful UI:

```bash
v2c review --voice-memos
```

Features:

1. Start local server on an available port.
2. Open browser.
3. Aggregate all `review-inbox.jsonl` files.
4. Show pending items in a list.
5. Click item to show:
   - extracted text
   - type/status
   - source segment and timestamp
   - source excerpt
   - full segment text
   - audio player starting near the segment time
6. Approve/reject/needs-context writes to `analysis/review-state.json`.
7. Filters by type and status.

This is enough to make the generated analysis usable.

## Implementation Order

1. Add `src/review/data.js` to scan packages and aggregate items.
2. Add `src/review/server.js` with JSON endpoints.
3. Add range-capable audio serving for `audio/audio.wav`.
4. Add static `index.html`, `app.js`, and `style.css`.
5. Add `v2c review --voice-memos` command.
6. Add review-state writes.
7. Add package status drawer.
8. Add on-demand clip generation.
9. Add project routing metadata.
10. Add aggregate export commands.

## Success Criteria

The UI is successful when:

- a user can review all pending extracted items without opening JSON files
- every item has visible source evidence
- audio playback starts near the relevant moment
- approval/rejection state persists
- rerunning analysis does not destroy review decisions
- the UI clearly shows which packages are complete or blocked
- the CLI remains simple: `v2c voice-memos` to process, `v2c review --voice-memos` to review

The goal is not to hide the file pipeline. The goal is to make the file pipeline reviewable.
