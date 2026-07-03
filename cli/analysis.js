import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { exec, fmtTime, info, step, done, warn } from "./util.js";
import { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, runLlmAnalysis } from "./llm-analysis.js";

const PROMPT_VERSION = "segment-analysis@2026-07-01";
const SEGMENT_SCHEMA_VERSION = 1;
const PAUSE_BREAK_MS = 45_000;
const MAX_SEGMENT_MS = 18 * 60 * 1000;
const MIN_SEGMENT_MS = 2 * 60 * 1000;
const DEFAULT_CODEX_MODEL = "gpt-5.4-mini";
const CUE_RE =
  /\b(next up|okay|quick interruption|continuing|moving on|separate thing|new topic|another thing|switching gears|back to|where was i)\b/i;

const DERIVED_FILES = [
  "tasks.jsonl",
  "claims.jsonl",
  "quotes.jsonl",
  "blog-seeds.md",
  "review-inbox.jsonl",
];

export async function analyzePackage(packageDir, opts = {}) {
  const root = path.resolve(expandHome(packageDir));
  const manifest = await readJson(path.join(root, ".v2c-manifest.json"));
  const transcript = await readTranscript(root);
  if (!transcript.items.length) {
    throw new Error(
      `No transcript found in ${root}. Expected transcript/transcript.json or transcript/transcript.txt.`,
    );
  }

  const analysisDir = path.join(root, "analysis");
  const segmentsPath = path.join(analysisDir, "segments.json");
  const digestPath = path.join(analysisDir, "session-digest.md");
  const codexDir = path.join(analysisDir, "codex");
  const exists = await pathExists(segmentsPath);
  if (exists && !opts.forceAnalysis && !opts.prepareCodex) {
    info(`analysis already exists: ${segmentsPath}`);
    return { root, skipped: true, segmentsPath, digestPath };
  }

  await fs.mkdir(analysisDir, { recursive: true });
  const sources = manifest?.sources || [];
  const segments = buildSegments(transcript.items, sources);
  const payload = {
    schemaVersion: SEGMENT_SCHEMA_VERSION,
    generatedAt: new Date(parseInt(process.env.V2C_NOW || Date.now(), 10))
      .toISOString(),
    sourcePackage: root,
    transcriptSource: transcript.source,
    segments,
  };
  await fs.writeFile(segmentsPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.writeFile(
    digestPath,
    renderDigest({ root, segments, manifest, transcript }),
    "utf8",
  );

  if (opts.prepareCodex) {
    await prepareCodexPackets({
      codexDir,
      root,
      segments,
      preferredModel: opts.codexModel || DEFAULT_CODEX_MODEL,
    });
  }

  return {
    root,
    skipped: false,
    segmentsPath,
    digestPath,
    codexDir,
    count: segments.length,
  };
}

export async function resetAnalysisAssets(packageDir) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  await fs.rm(analysisDir, { recursive: true, force: true });
  return { root, analysisDir };
}

export async function importCodexResults(packageDir, opts = {}) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  const codexDir = path.join(analysisDir, "codex");
  const manifestPath = path.join(codexDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (!manifest) throw new Error(`Missing Codex manifest: ${manifestPath}`);

  const source = path.resolve(
    expandHome(opts.from) ||
      path.join(codexDir, manifest.outputPath || "results/segment-analysis.jsonl"),
  );
  const records = await readJsonl(source);
  validateSegmentAnalysis(records, manifest);

  const codexResultPath = path.join(
    codexDir,
    manifest.outputPath || "results/segment-analysis.jsonl",
  );
  const analysisPath = path.join(analysisDir, "segment-analysis.jsonl");
  await fs.mkdir(path.dirname(codexResultPath), { recursive: true });
  await fs.mkdir(analysisDir, { recursive: true });
  const body = records.map((record) => JSON.stringify(record)).join("\n") + "\n";
  await fs.writeFile(codexResultPath, body, "utf8");
  await fs.writeFile(analysisPath, body, "utf8");

  return {
    root,
    source,
    codexResultPath,
    analysisPath,
    count: records.length,
  };
}

export async function deriveArtifacts(packageDir) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  const segmentAnalysisPath = path.join(analysisDir, "segment-analysis.jsonl");
  const records = await readJsonl(segmentAnalysisPath);
  if (!records.length) {
    throw new Error(`No segment analysis records found: ${segmentAnalysisPath}`);
  }

  const tasks = collectItems(records, "tasks", "task");
  const claims = [
    ...collectItems(records, "claims", "claim"),
    ...collectItems(records, "opinions", "opinion"),
    ...collectItems(records, "experience", "experience"),
  ];
  const quotes = collectItems(records, "quoteCandidates", "quote");
  const review = [
    ...tasks,
    ...claims,
    ...quotes,
    ...collectItems(records, "blogSeeds", "blog_seed"),
    ...collectItems(records, "sensitiveFlags", "sensitive_flag"),
  ].map((item, index) => ({
    id: `review_${String(index + 1).padStart(4, "0")}`,
    status: "pending",
    type: item.type,
    title: item.text,
    body: item.excerpt || item.text,
    source: item.source,
    item,
  }));

  await writeJsonl(path.join(analysisDir, "tasks.jsonl"), tasks);
  await writeJsonl(path.join(analysisDir, "claims.jsonl"), claims);
  await writeJsonl(path.join(analysisDir, "quotes.jsonl"), quotes);
  await fs.writeFile(
    path.join(analysisDir, "blog-seeds.md"),
    renderBlogSeeds(records),
    "utf8",
  );
  await writeJsonl(path.join(analysisDir, "review-inbox.jsonl"), review);

  return {
    root,
    tasks: tasks.length,
    claims: claims.length,
    quotes: quotes.length,
    review: review.length,
    files: [
      path.join(analysisDir, "tasks.jsonl"),
      path.join(analysisDir, "claims.jsonl"),
      path.join(analysisDir, "quotes.jsonl"),
      path.join(analysisDir, "blog-seeds.md"),
      path.join(analysisDir, "review-inbox.jsonl"),
    ],
  };
}

export async function getPackageStatus(packageDir) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  const codexDir = path.join(analysisDir, "codex");
  const manifest = await readJson(path.join(codexDir, "manifest.json"));
  const codexResultPath = manifest
    ? path.join(codexDir, manifest.outputPath || "results/segment-analysis.jsonl")
    : path.join(codexDir, "results", "segment-analysis.jsonl");

  const files = {
    transcriptJson: path.join(root, "transcript", "transcript.json"),
    transcriptTxt: path.join(root, "transcript", "transcript.txt"),
    segments: path.join(analysisDir, "segments.json"),
    codexManifest: path.join(codexDir, "manifest.json"),
    codexResult: codexResultPath,
    segmentAnalysis: path.join(analysisDir, "segment-analysis.jsonl"),
    reviewInbox: path.join(analysisDir, "review-inbox.jsonl"),
    transcriptSummary: path.join(analysisDir, "transcript-summary.json"),
    llmError: path.join(analysisDir, "llm-error.json"),
  };
  const exists = {};
  for (const [key, file] of Object.entries(files)) exists[key] = await pathExists(file);
  const derivedComplete = (
    await Promise.all(
      DERIVED_FILES.map((file) => pathExists(path.join(analysisDir, file))),
    )
  ).every(Boolean);

  let stage = "new";
  let nextAction = "transcribe";
  if (exists.transcriptJson || exists.transcriptTxt) {
    stage = "transcribed";
    nextAction = "segment";
  }
  if (exists.segments) {
    stage = "segments_ready";
    nextAction = "run_llm";
  }
  if (exists.codexManifest) {
    stage = "waiting_for_codex";
    nextAction = "run_codex";
  }
  if (exists.llmError && !exists.segmentAnalysis) {
    stage = "llm_failed";
    nextAction = "run_llm";
  }
  if (exists.codexResult && !exists.segmentAnalysis) {
    stage = "codex_ready_to_import";
    nextAction = "import_codex";
  }
  if (exists.segmentAnalysis) {
    stage = derivedComplete ? "derived" : "analysis_ready";
    nextAction = derivedComplete ? "none" : "derive";
  }

  return { root, stage, nextAction, files, exists, derivedComplete };
}

export async function continueAnalysisPackage(packageDir, opts = {}) {
  const root = path.resolve(expandHome(packageDir));
  const actions = [];
  let ranLlm = false;

  let status = await getPackageStatus(root);
  if (!status.exists.segments || opts.forceAnalysis) {
    actions.push("segment");
    await analyzePackage(root, { ...opts, prepareCodex: false });
    status = await getPackageStatus(root);
  }

  if (!status.exists.codexManifest || opts.forceAnalysis || opts.prepareCodex) {
    if (opts.prepareCodex || (!opts.runLlm && opts.runCodex !== false)) {
      actions.push("prepare_codex");
      await analyzePackage(root, { ...opts, prepareCodex: true, forceAnalysis: true });
      status = await getPackageStatus(root);
    }
  }

  if (!status.exists.segmentAnalysis) {
    if (opts.runLlm) {
      actions.push("run_llm");
      await runLlmAnalysis(root, opts);
      ranLlm = true;
      status = await getPackageStatus(root);
    } else if (status.exists.codexResult) {
      actions.push("import_codex");
      await importCodexResults(root, opts);
      status = await getPackageStatus(root);
    } else if (opts.runCodex !== false) {
      actions.push("run_codex");
      await runCodexAnalysis(root, opts);
      status = await getPackageStatus(root);
      actions.push("import_codex");
      await importCodexResults(root, opts);
      status = await getPackageStatus(root);
    }
  } else if (opts.runLlm && !status.exists.transcriptSummary) {
    actions.push("run_llm");
    await runLlmAnalysis(root, opts);
    ranLlm = true;
    status = await getPackageStatus(root);
  }

  if (status.exists.segmentAnalysis && (!status.derivedComplete || ranLlm)) {
    actions.push("derive");
    await deriveArtifacts(root);
    status = await getPackageStatus(root);
  }

  return { root, actions, status };
}

export { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, runLlmAnalysis };

export async function runCodexAnalysis(packageDir, opts = {}) {
  const root = path.resolve(expandHome(packageDir));
  const codexDir = path.join(root, "analysis", "codex");
  const manifestPath = path.join(codexDir, "manifest.json");
  const manifest = await readJson(manifestPath);
  if (!manifest) throw new Error(`Missing Codex manifest: ${manifestPath}`);

  const model = opts.codexModel || DEFAULT_CODEX_MODEL;
  if (
    manifest.preferredModel &&
    manifest.preferredModel !== model &&
    manifest.preferredModel !== "codex-default"
  ) {
    warn(
      `Ignoring stale Codex manifest model ${manifest.preferredModel}; using ${model}.`,
    );
  }
  const prompt = [
    `Read manifest.json and instructions.md in: ${codexDir}`,
    "",
    "Process every segment packet listed in the manifest.",
    "Write JSONL to the manifest outputPath exactly.",
    "Follow expected-output-schema.json exactly.",
    "Do not invent unsupported facts.",
    "Do not edit repository files or any files outside this context package.",
  ].join("\n");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "-C",
    codexDir,
    "--add-dir",
    root,
    "-s",
    "workspace-write",
  ];
  if (model) args.push("-m", model);
  args.push(prompt);

  try {
    await exec("codex", args, { quiet: false });
  } catch (err) {
    throw new Error(
      `Codex model analysis failed. Retry this package with: v2c analyze ${root} --prepare-codex --run-codex --derive\n${err.message}`,
    );
  }
  const resultPath = path.join(
    codexDir,
    manifest.outputPath || "results/segment-analysis.jsonl",
  );
  if (!(await pathExists(resultPath))) {
    throw new Error(`Codex finished but did not write expected result: ${resultPath}`);
  }
  return { root, resultPath };
}

export async function analyzeVoiceMemoPackages(opts = {}) {
  const root = path.resolve(expandHome(opts.output || defaultVoiceMemoOutput()));
  const packages = await findContextPackages(root);
  if (!packages.length) {
    warn(`No context packages found under ${root}. Run \`v2c voice-memos\` first.`);
    return [];
  }

  const results = [];
  for (const packageDir of packages) {
    const hasAnalysis = await pathExists(
      path.join(packageDir, "analysis", "segments.json"),
    );
    if (hasAnalysis && !opts.forceAnalysis && !opts.prepareCodex) continue;
    step(`Analyzing ${path.basename(packageDir)}`);
    const result = await analyzePackage(packageDir, opts);
    done(`${result.count || "existing"} segment(s)`);
    results.push(result);
  }
  if (!results.length) info("all voice memo packages already have analysis");
  return results;
}

function validateSegmentAnalysis(records, manifest) {
  const expected = new Set((manifest.packets || []).map((packet) => packet.segmentId));
  const seen = new Set();
  const required = [
    "segmentId",
    "promptVersion",
    "start",
    "end",
    "sourceFiles",
    "claims",
    "opinions",
    "experience",
    "tasks",
    "blogSeeds",
    "tweetCandidates",
    "quoteCandidates",
    "voiceMarkers",
    "followUpQuestions",
    "sensitiveFlags",
  ];
  const arrayFields = required.slice(5);
  const errors = [];

  records.forEach((record, index) => {
    const line = index + 1;
    for (const field of required) {
      if (!(field in record)) errors.push(`line ${line}: missing ${field}`);
    }
    if (!expected.has(record.segmentId)) {
      errors.push(`line ${line}: unknown segmentId ${record.segmentId}`);
    }
    if (seen.has(record.segmentId)) {
      errors.push(`line ${line}: duplicate segmentId ${record.segmentId}`);
    }
    seen.add(record.segmentId);
    if (record.promptVersion !== manifest.promptVersion) {
      errors.push(`line ${line}: expected promptVersion ${manifest.promptVersion}`);
    }
    if (!Array.isArray(record.sourceFiles)) {
      errors.push(`line ${line}: sourceFiles must be an array`);
    }
    for (const field of arrayFields) {
      if (!Array.isArray(record[field])) errors.push(`line ${line}: ${field} must be an array`);
    }
  });

  for (const id of expected) {
    if (!seen.has(id)) errors.push(`missing segmentId ${id}`);
  }
  if (errors.length) {
    throw new Error(`Codex result validation failed:\n${errors.join("\n")}`);
  }
}

function collectItems(records, field, type) {
  const items = [];
  for (const record of records) {
    for (const [index, item] of (record[field] || []).entries()) {
      const text = typeof item === "string" ? item : item.text;
      if (!text) continue;
      items.push({
        id: `${type}_${record.segmentId}_${String(index + 1).padStart(2, "0")}`,
        type,
        text,
        excerpt: typeof item === "string" ? "" : item.excerpt || "",
        uncertainty: typeof item === "string" ? false : !!item.uncertainty,
        source: {
          segmentId: record.segmentId,
          start: record.start,
          end: record.end,
          sourceFiles: record.sourceFiles || [],
        },
      });
    }
  }
  return items;
}

function renderBlogSeeds(records) {
  const lines = ["# Blog Seeds", ""];
  let count = 0;
  for (const record of records) {
    for (const item of record.blogSeeds || []) {
      count++;
      const text = typeof item === "string" ? item : item.text;
      const excerpt = typeof item === "string" ? "" : item.excerpt || "";
      if (!text) continue;
      lines.push(`## ${count}. ${text}`);
      lines.push("");
      lines.push(`- Source: ${record.segmentId}, ${record.start} - ${record.end}`);
      if (excerpt) lines.push(`- Excerpt: ${excerpt}`);
      lines.push("");
    }
  }
  if (!count) lines.push("_No blog seeds extracted._", "");
  return lines.join("\n");
}

export async function findContextPackages(root) {
  const found = [];
  await walk(root, async (dir, entries) => {
    if (entries.some((e) => e.isFile() && e.name === ".v2c-manifest.json")) {
      found.push(dir);
      return false;
    }
    return true;
  }).catch(() => {});
  return found.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

export function defaultVoiceMemoOutput() {
  return path.join(os.homedir(), ".v2c-voice-memos");
}

async function readTranscript(root) {
  const jsonPath = path.join(root, "transcript", "transcript.json");
  const txtPath = path.join(root, "transcript", "transcript.txt");
  const json = await readJson(jsonPath);
  if (json) {
    const items = transcriptSegments(json)
      .map((s, index) => transcriptItem(s, index))
      .filter((s) => s.text);
    return { source: "transcript/transcript.json", items };
  }

  const txt = await fs.readFile(txtPath, "utf8").catch(() => "");
  return {
    source: "transcript/transcript.txt",
    items: txt.trim()
      ? [{ index: 0, startMs: 0, endMs: 0, text: txt.trim() }]
      : [],
  };
}

function transcriptSegments(json) {
  return (
    json.transcription ||
    json.sentences ||
    json.segments ||
    json.chunks ||
    json.results ||
    (Array.isArray(json) ? json : [])
  );
}

function transcriptItem(segment, index) {
  const startMs = transcriptTimeMs(
    segment.offsets?.from ??
      segment.start_ms ??
      segment.start ??
      segment.start_time ??
      segment.timestamp?.[0] ??
      segment.timestamps?.from ??
      0,
    segment.offsets?.from != null || segment.start_ms != null,
  );
  const rawEnd =
    segment.offsets?.to ??
    segment.end_ms ??
    segment.end ??
    segment.end_time ??
    segment.timestamp?.[1] ??
    segment.timestamps?.to;
  const endMs =
    rawEnd == null
      ? startMs
      : transcriptTimeMs(rawEnd, segment.offsets?.to != null || segment.end_ms != null);
  return {
    index,
    startMs,
    endMs: Math.max(endMs, startMs),
    text: String(segment.text || segment.transcript || segment.sentence || "").trim(),
  };
}

function transcriptTimeMs(value, alreadyMs) {
  if (typeof value === "number") return alreadyMs ? value : value * 1000;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return alreadyMs ? parsed : parsed * 1000;
}

function buildSegments(items, sources) {
  const segments = [];
  let current = [];

  for (const item of items) {
    if (current.length && shouldBreak(current, item, sources)) {
      segments.push(finalizeSegment(current, segments.length, sources));
      current = [];
    }
    current.push(item);
  }
  if (current.length) {
    segments.push(finalizeSegment(current, segments.length, sources));
  }
  return segments;
}

function shouldBreak(current, next, sources) {
  const first = current[0];
  const prev = current[current.length - 1];
  const elapsed = next.startMs - first.startMs;
  const pause = next.startMs - prev.endMs;
  const prevSource = sourceForMs(sources, prev.startMs)?.name;
  const nextSource = sourceForMs(sources, next.startMs)?.name;

  if (prevSource && nextSource && prevSource !== nextSource) return true;
  if (pause >= PAUSE_BREAK_MS) return true;
  if (elapsed >= MIN_SEGMENT_MS && CUE_RE.test(next.text)) return true;
  if (elapsed >= MAX_SEGMENT_MS) return true;
  return false;
}

function finalizeSegment(items, index, sources) {
  const first = items[0];
  const last = items[items.length - 1];
  const startMs = first.startMs;
  const endMs = Math.max(last.endMs, last.startMs);
  const text = items.map((s) => s.text).join(" ").replace(/\s+/g, " ").trim();
  const title = titleFromText(text, index);
  const sourceFiles = [
    ...new Set(
      items
        .map((item) => sourceForMs(sources, item.startMs)?.name)
        .filter(Boolean),
    ),
  ];

  return {
    id: `seg_${String(index + 1).padStart(3, "0")}`,
    startMs,
    endMs,
    start: fmtTime(startMs / 1000),
    end: fmtTime(endMs / 1000),
    title,
    gist: gistFromText(text),
    summary: summarizeText(text),
    sourceFiles,
    text,
  };
}

function sourceForMs(sources, ms) {
  if (!sources.length) return null;
  const t = ms / 1000;
  return (
    sources.find(
      (s) => t >= s.offset && t < s.offset + (s.duration || Infinity),
    ) || sources[sources.length - 1]
  );
}

function titleFromText(text, index) {
  const words = significantWords(text).slice(0, 5);
  if (!words.length) return `Segment ${index + 1}`;
  return words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function gistFromText(text) {
  const sentences = splitSentences(text);
  return sentences.slice(0, 2).join(" ").slice(0, 240);
}

function summarizeText(text) {
  const sentences = splitSentences(text);
  if (sentences.length <= 4) return sentences.join(" ");
  return [
    sentences[0],
    sentences[1],
    sentences[Math.floor(sentences.length / 2)],
    sentences.at(-1),
  ]
    .filter(Boolean)
    .join(" ");
}

function splitSentences(text) {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function significantWords(text) {
  const stop = new Set([
    "about",
    "actually",
    "again",
    "because",
    "going",
    "maybe",
    "really",
    "right",
    "should",
    "think",
    "this",
    "that",
    "there",
    "thing",
    "with",
  ]);
  return [...text.toLowerCase().matchAll(/[a-z][a-z0-9-]{3,}/g)]
    .map((m) => m[0])
    .filter((w) => !stop.has(w));
}

function renderDigest({ root, segments, manifest, transcript }) {
  const lines = [];
  lines.push(`# Session Digest\n`);
  lines.push(`- Package: \`${root}\``);
  lines.push(`- Transcript: \`${transcript.source}\``);
  if (manifest?.totalDuration != null) {
    lines.push(`- Duration: ${fmtTime(manifest.totalDuration)}`);
  }
  lines.push(`- Segments: ${segments.length}`);
  lines.push("");
  lines.push(`## Segments\n`);
  for (const seg of segments) {
    const sources = seg.sourceFiles.length ? ` (${seg.sourceFiles.join(", ")})` : "";
    lines.push(`### ${seg.id}: ${seg.title}`);
    lines.push(`- Time: ${seg.start} - ${seg.end}${sources}`);
    lines.push(`- Gist: ${seg.gist || "(none)"}`);
    lines.push("");
    lines.push(seg.summary || "(no summary)");
    lines.push("");
  }
  return lines.join("\n");
}

async function prepareCodexPackets({ codexDir, root, segments, preferredModel }) {
  const packetsDir = path.join(codexDir, "segment-packets");
  const resultsDir = path.join(codexDir, "results");
  await fs.mkdir(packetsDir, { recursive: true });
  await fs.mkdir(resultsDir, { recursive: true });

  const packetFiles = [];
  for (const segment of segments) {
    const file = `${segment.id}.md`;
    await fs.writeFile(path.join(packetsDir, file), renderPacket(segment), "utf8");
    packetFiles.push({ segmentId: segment.id, file: `segment-packets/${file}` });
  }

  await fs.writeFile(
    path.join(codexDir, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        promptVersion: PROMPT_VERSION,
        preferredModel,
        sourcePackage: root,
        outputPath: "results/segment-analysis.jsonl",
        packets: packetFiles,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(codexDir, "instructions.md"),
    renderCodexInstructions(),
    "utf8",
  );
  await fs.writeFile(
    path.join(codexDir, "expected-output-schema.json"),
    `${JSON.stringify(expectedOutputSchema(), null, 2)}\n`,
    "utf8",
  );
}

function renderPacket(segment) {
  return `# Segment ${segment.id}

Start: ${segment.start}
End: ${segment.end}
Source files: ${segment.sourceFiles.join(", ") || "(unknown)"}
Prompt version: ${PROMPT_VERSION}

## Task

Return one JSON object for this segment with segmentId, promptVersion, start, end, sourceFiles, claims, opinions, experience, tasks, blog seeds, tweet candidates, quote candidates, voice markers, follow-up questions, and sensitive flags.

## Transcript

${segment.text}
`;
}

function renderCodexInstructions() {
  return `# Segment Analysis Instructions

Use the Codex CLI's configured default model unless the command explicitly selected a model. Read every packet listed in \`manifest.json\` and write JSONL to \`results/segment-analysis.jsonl\`.

Each line must be one JSON object matching \`expected-output-schema.json\`. Preserve \`segmentId\`, \`start\`, \`end\`, \`sourceFiles\`, and \`promptVersion\`. Do not invent facts, examples, tasks, opinions, project names, or conclusions that are not supported by the segment transcript. Mark uncertainty explicitly instead of filling gaps.

Every extracted item should include a short source excerpt from the segment text. Leave arrays empty when no grounded item exists.
`;
}

function expectedOutputSchema() {
  return {
    type: "object",
    required: [
      "segmentId",
      "promptVersion",
      "start",
      "end",
      "sourceFiles",
      "claims",
      "opinions",
      "experience",
      "tasks",
      "blogSeeds",
      "tweetCandidates",
      "quoteCandidates",
      "voiceMarkers",
      "followUpQuestions",
      "sensitiveFlags",
    ],
    properties: {
      segmentId: { type: "string" },
      promptVersion: { const: PROMPT_VERSION },
      start: { type: "string" },
      end: { type: "string" },
      sourceFiles: { type: "array", items: { type: "string" } },
      claims: { type: "array" },
      opinions: { type: "array" },
      experience: { type: "array" },
      tasks: { type: "array" },
      blogSeeds: { type: "array" },
      tweetCandidates: { type: "array" },
      quoteCandidates: { type: "array" },
      voiceMarkers: { type: "array" },
      followUpQuestions: { type: "array" },
      sensitiveFlags: { type: "array" },
    },
  };
}

async function walk(dir, onDir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const shouldDescend = await onDir(dir, entries);
  if (shouldDescend === false) return;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await walk(path.join(dir, entry.name), onDir).catch(() => {});
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function readJsonl(file) {
  const raw = await fs.readFile(file, "utf8").catch((err) => {
    throw new Error(`Could not read JSONL file ${file}: ${err.message}`);
  });
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (err) {
        throw new Error(`Invalid JSONL at ${file}:${index + 1}: ${err.message}`);
      }
    });
}

async function writeJsonl(file, records) {
  await fs.writeFile(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
}

async function pathExists(file) {
  return fs.stat(file).then(() => true, () => false);
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
