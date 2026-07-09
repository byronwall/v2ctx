import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fmtTime, info, step, done, warn } from "./util.js";
import {
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  runFollowUpQuestionsAnalysis,
  runLlmAnalysis,
} from "./llm-analysis.js";

const SEGMENT_SCHEMA_VERSION = 1;

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
  const exists = await pathExists(segmentsPath);
  if (exists && !opts.forceAnalysis) {
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

  return {
    root,
    skipped: false,
    segmentsPath,
    digestPath,
    count: segments.length,
  };
}

export async function resetAnalysisAssets(packageDir) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  await fs.rm(analysisDir, { recursive: true, force: true });
  return { root, analysisDir };
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

  const files = {
    transcriptJson: path.join(root, "transcript", "transcript.json"),
    transcriptTxt: path.join(root, "transcript", "transcript.txt"),
    segments: path.join(analysisDir, "segments.json"),
    segmentAnalysis: path.join(analysisDir, "segment-analysis.jsonl"),
    reviewInbox: path.join(analysisDir, "review-inbox.jsonl"),
    transcriptSummary: path.join(analysisDir, "transcript-summary.json"),
    followUpQuestions: path.join(analysisDir, "follow-up-questions.json"),
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
  if (exists.llmError && !exists.segmentAnalysis) {
    stage = "llm_failed";
    nextAction = "run_llm";
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
    await analyzePackage(root, opts);
    status = await getPackageStatus(root);
  }

  if (!status.exists.segmentAnalysis) {
    if (opts.runLlm) {
      actions.push("run_llm");
      await runLlmAnalysis(root, opts);
      ranLlm = true;
      status = await getPackageStatus(root);
    }
  } else if (opts.runLlm && (!status.exists.transcriptSummary || !status.exists.followUpQuestions)) {
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

export { DEFAULT_LLM_MODEL, DEFAULT_LLM_PROVIDER, runFollowUpQuestionsAnalysis, runLlmAnalysis };

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
    if (hasAnalysis && !opts.forceAnalysis) continue;
    step(`Analyzing ${path.basename(packageDir)}`);
    const result = await analyzePackage(packageDir, opts);
    done(`${result.count || "existing"} segment(s)`);
    results.push(result);
  }
  if (!results.length) info("all voice memo packages already have analysis");
  return results;
}

function collectItems(records, field, type) {
  const items = [];
  for (const record of records) {
    for (const [index, item] of (record[field] || []).entries()) {
      const text = typeof item === "string" ? item : item.text;
      if (!text) continue;
      const primarySource = item?.sourceSegments?.[0];
      items.push({
        id: `${type}_${record.segmentId}_${String(index + 1).padStart(2, "0")}`,
        type,
        text,
        excerpt: typeof item === "string" ? "" : item.excerpt || "",
        uncertainty: typeof item === "string" ? false : !!item.uncertainty,
        evidence: typeof item === "string" ? "missing" : item.evidence || "missing",
        supportingQuotes: typeof item === "string" ? [] : item.supportingQuotes || [],
        sourceSegments: typeof item === "string" ? [] : item.sourceSegments || [],
        source: {
          segmentId: primarySource?.segmentId || record.segmentId,
          start: primarySource?.start || record.start,
          end: primarySource?.end || record.end,
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
  if (!sources.length) return [finalizeSegment(items, 0, sources)];
  return sources
    .map((source, index) => {
      const sourceItems = items.filter((item) => sourceForMs(sources, item.startMs)?.name === source.name);
      return sourceItems.length ? finalizeSegment(sourceItems, index, sources) : null;
    })
    .filter(Boolean);
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
    boundary: {
      kind: sourceFiles.length === 1 ? "source_file" : "transcript",
      reason:
        sourceFiles.length === 1
          ? "One source audio file is treated as a meaningful initial boundary."
          : "No source-file metadata was available, so the transcript is kept as one initial unit.",
    },
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
