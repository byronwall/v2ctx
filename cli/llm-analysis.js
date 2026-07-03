import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import dotenv from "dotenv";
import { done, fmtTime, info, step, warn } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");

export const LLM_PROMPT_VERSION = "transcript-llm-analysis@2026-07-03.1";
export const DEFAULT_LLM_PROVIDER = "openai";
export const DEFAULT_LLM_MODEL = "gpt-5.4-mini";

const ITEM_FIELDS = [
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

const PRICE_SOURCE = {
  provider: "openai",
  url: "https://developers.openai.com/api/docs/pricing",
  retrievedAt: "2026-07-03",
  unit: "usd_per_1m_tokens",
};

const OPENAI_STANDARD_PRICES = {
  "gpt-5.5": {
    shortContext: { input: 5, cachedInput: 0.5, output: 30 },
    longContext: { input: 10, cachedInput: 1, output: 45 },
  },
  "gpt-5.5-pro": {
    shortContext: { input: 30, cachedInput: null, output: 180 },
    longContext: { input: 60, cachedInput: null, output: 270 },
  },
  "gpt-5.4": {
    shortContext: { input: 2.5, cachedInput: 0.25, output: 15 },
    longContext: { input: 5, cachedInput: 0.5, output: 22.5 },
  },
  "gpt-5.4-mini": {
    shortContext: { input: 0.75, cachedInput: 0.075, output: 4.5 },
  },
  "gpt-5.4-nano": {
    shortContext: { input: 0.2, cachedInput: 0.02, output: 1.25 },
  },
  "gpt-5.4-pro": {
    shortContext: { input: 30, cachedInput: null, output: 180 },
    longContext: { input: 60, cachedInput: null, output: 270 },
  },
};

export async function runLlmAnalysis(packageDir, opts = {}) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  const segmentsPath = path.join(analysisDir, "segments.json");
  const errorPath = path.join(analysisDir, "llm-error.json");
  const provider = opts.llmProvider || DEFAULT_LLM_PROVIDER;
  const model = opts.llmModel || DEFAULT_LLM_MODEL;

  if (provider !== "openai") {
    throw new Error(`Unsupported LLM provider: ${provider}. Only "openai" is supported.`);
  }

  const segmentsPayload = await readJson(segmentsPath);
  const segments = segmentsPayload?.segments || [];
  if (!segments.length) {
    throw new Error(`No segments found for LLM analysis: ${segmentsPath}`);
  }

  const startedAt = new Date(parseInt(process.env.V2C_NOW || Date.now(), 10)).toISOString();
  const startedMs = Date.now();
  step(`LLM transcript analysis: ${path.basename(root)}`);
  info(`provider=${provider} model=${model} segments=${segments.length}`);
  info(`package=${root}`);
  try {
    await fs.rm(errorPath, { force: true });
    info("loading OpenAI client and .env");
    const client = opts.openAIClient || createOpenAIClient(root);
    info("OpenAI client ready");
    const rewrittenSegments = [];
    const records = [];
    const llmUsage = createUsageAccumulator(provider, model);

    for (const [index, segment] of segments.entries()) {
      const label = `${segment.id} (${index + 1}/${segments.length}, ${segment.start || fmtTime((segment.startMs || 0) / 1000)} - ${segment.end || fmtTime((segment.endMs || 0) / 1000)})`;
      info(`rewrite start: ${label}`);
      const rewriteCall = await rewriteSegment(client, { model, segment });
      const rewritten = rewriteCall.data;
      addUsage(llmUsage, rewriteCall);
      info(
        `rewrite done: ${label} -> ${rewritten.title || segment.title || "(untitled)"} ${formatCallUsage(rewriteCall)}`,
      );
      rewrittenSegments.push({
        ...segment,
        title: rewritten.title || segment.title,
        gist: rewritten.gist || segment.gist,
        summary: rewritten.summary || segment.summary,
        cleanedText: rewritten.cleanedText || segment.text,
        sectionHints: rewritten.sectionHints || [],
      });

      info(`extract start: ${label}`);
      const extractionCall = await extractSegment(client, { model, segment });
      const extraction = extractionCall.data;
      addUsage(llmUsage, extractionCall);
      const record = normalizeExtractionRecord(segment, extraction);
      records.push(record);
      info(`extract done: ${label} -> ${itemCount(record)} item(s) ${formatCallUsage(extractionCall)}`);
    }

    info(`synthesis start: ${records.length} segment record(s)`);
    const synthesisCall = await synthesizeTranscript(client, {
      model,
      root,
      segments: rewrittenSegments,
      records,
    });
    const summary = synthesisCall.data;
    addUsage(llmUsage, synthesisCall);
    info(
      `synthesis done: ${summary.title || path.basename(root)}; ${(summary.topBullets || []).length} bullet(s), ${(summary.sections || []).length} section(s) ${formatCallUsage(synthesisCall)}`,
    );
    info(`LLM total: ${formatUsageSummary(llmUsage.totals)} ${formatCost(llmUsage.totalCost)}`);

    const updatedSegmentsPayload = {
      ...segmentsPayload,
      promptVersion: LLM_PROMPT_VERSION,
      llmModel: model,
      generatedAt: startedAt,
      segments: rewrittenSegments,
    };
    info(`writing ${path.relative(root, segmentsPath)}`);
    await fs.writeFile(segmentsPath, `${JSON.stringify(updatedSegmentsPayload, null, 2)}\n`, "utf8");

    const segmentAnalysisPath = path.join(analysisDir, "segment-analysis.jsonl");
    info(`writing ${path.relative(root, segmentAnalysisPath)}`);
    await writeJsonl(segmentAnalysisPath, records);

    const transcriptSummaryPath = path.join(analysisDir, "transcript-summary.json");
    info(`writing ${path.relative(root, transcriptSummaryPath)}`);
    await fs.writeFile(
      transcriptSummaryPath,
      `${JSON.stringify(
        {
          promptVersion: LLM_PROMPT_VERSION,
          model,
          provider,
          generatedAt: startedAt,
          usage: usageSummaryForJson(llmUsage),
          title: normalizeTitle(summary.title, root),
          summary: summary.summary || "",
          topBullets: summary.topBullets || [],
          themes: summary.themes || [],
          sections: normalizeSummarySections(summary.sections || [], rewrittenSegments),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    done(`LLM analysis complete in ${formatDuration(Date.now() - startedMs)}`);

    return {
      root,
      model,
      provider,
      segmentAnalysisPath,
      transcriptSummaryPath,
      count: records.length,
      usage: usageSummaryForJson(llmUsage),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warn(`LLM analysis failed after ${formatDuration(Date.now() - startedMs)}: ${message}`);
    info(`writing ${path.relative(root, errorPath)}`);
    await fs.writeFile(
      errorPath,
      `${JSON.stringify(
        {
          promptVersion: LLM_PROMPT_VERSION,
          model,
          provider,
          generatedAt: startedAt,
          error: message,
          rerun: `v2c analyze ${root} --run-llm --derive`,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    throw new Error(
      `LLM transcript analysis failed. Retry this package with: v2c analyze ${root} --run-llm --derive\n${message}`,
    );
  }
}

function createOpenAIClient(packageRoot) {
  loadEnvFiles(packageRoot);
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      `OPENAI_API_KEY is required for --run-llm. Checked .env near ${process.cwd()}, ${REPO_ROOT}, and the context package.`,
    );
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function loadEnvFiles(packageRoot) {
  for (const dir of envSearchDirs(packageRoot)) {
    dotenv.config({ path: path.join(dir, ".env"), override: false, quiet: true });
  }
}

function envSearchDirs(packageRoot) {
  return uniquePaths([
    process.cwd(),
    path.resolve(process.cwd(), ".."),
    REPO_ROOT,
    path.resolve(REPO_ROOT, ".."),
    packageRoot,
    path.resolve(packageRoot, ".."),
    os.homedir(),
  ]);
}

function uniquePaths(paths) {
  const seen = new Set();
  return paths.filter((item) => {
    const resolved = path.resolve(item);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function itemCount(record) {
  return ITEM_FIELDS.reduce((sum, field) => sum + (record[field]?.length || 0), 0);
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

function createUsageAccumulator(provider, model) {
  const pricing = priceForModel(provider, model);
  return {
    provider,
    model,
    pricing,
    calls: 0,
    totalCost: pricing ? 0 : null,
    totals: emptyUsage(),
  };
}

function emptyUsage() {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function addUsage(accumulator, call) {
  accumulator.calls += 1;
  accumulator.totals.inputTokens += call.usage.inputTokens;
  accumulator.totals.cachedInputTokens += call.usage.cachedInputTokens;
  accumulator.totals.outputTokens += call.usage.outputTokens;
  accumulator.totals.totalTokens += call.usage.totalTokens;
  if (accumulator.totalCost !== null && call.cost !== null) {
    accumulator.totalCost += call.cost;
  }
}

function priceForModel(provider, model) {
  if (provider !== "openai") return null;
  const baseModel = String(model || "").replace(/-\d{4}-\d{2}-\d{2}$/, "");
  const prices = OPENAI_STANDARD_PRICES[baseModel];
  if (!prices) return null;
  return {
    model: baseModel,
    context: "short",
    ...prices.shortContext,
    source: PRICE_SOURCE,
  };
}

function normalizeUsage(usage) {
  const inputTokens = numberOrZero(usage?.input_tokens);
  const cachedInputTokens = numberOrZero(usage?.input_tokens_details?.cached_tokens);
  const outputTokens = numberOrZero(usage?.output_tokens);
  return {
    inputTokens,
    cachedInputTokens,
    outputTokens,
    totalTokens: numberOrZero(usage?.total_tokens) || inputTokens + outputTokens,
  };
}

function numberOrZero(value) {
  return Number.isFinite(value) ? value : 0;
}

function estimateCost(usage, pricing) {
  if (!pricing) return null;
  const cachedInputTokens = pricing.cachedInput === null ? 0 : usage.cachedInputTokens;
  const uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const cachedInputCost =
    pricing.cachedInput === null ? 0 : (cachedInputTokens / 1_000_000) * pricing.cachedInput;
  const inputCost = (uncachedInputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  return inputCost + cachedInputCost + outputCost;
}

function formatCallUsage(call) {
  return `(${formatUsageSummary(call.usage)} ${formatCost(call.cost)})`;
}

function formatUsageSummary(usage) {
  const cached = usage.cachedInputTokens ? `, cached=${formatCount(usage.cachedInputTokens)}` : "";
  return `tokens in=${formatCount(usage.inputTokens)}${cached}, out=${formatCount(usage.outputTokens)}, total=${formatCount(usage.totalTokens)}`;
}

function formatCount(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatCost(cost) {
  if (cost === null) return "cost=unknown";
  if (cost > 0 && cost < 0.01) return `cost=$${cost.toFixed(4)}`;
  return `cost=$${cost.toFixed(2)}`;
}

function usageSummaryForJson(accumulator) {
  return {
    provider: accumulator.provider,
    model: accumulator.model,
    calls: accumulator.calls,
    inputTokens: accumulator.totals.inputTokens,
    cachedInputTokens: accumulator.totals.cachedInputTokens,
    outputTokens: accumulator.totals.outputTokens,
    totalTokens: accumulator.totals.totalTokens,
    estimatedCostUsd: accumulator.totalCost,
    pricing: accumulator.pricing
      ? {
          source: accumulator.pricing.source,
          model: accumulator.pricing.model,
          context: accumulator.pricing.context,
          inputUsdPer1MTokens: accumulator.pricing.input,
          cachedInputUsdPer1MTokens: accumulator.pricing.cachedInput,
          outputUsdPer1MTokens: accumulator.pricing.output,
        }
      : null,
  };
}

async function rewriteSegment(client, { model, segment }) {
  return callStructured(client, {
    model,
    name: "segment_rewrite",
    schema: segmentRewriteSchema(),
    input: [
      "Clean and structure this voice memo transcript segment.",
      "Keep the meaning grounded in the source text. Remove filler and false starts only when they do not carry meaning.",
      "Return concise section metadata and readable cleaned text.",
      "",
      segmentInput(segment),
    ].join("\n"),
  });
}

async function extractSegment(client, { model, segment }) {
  return callStructured(client, {
    model,
    name: "segment_extraction",
    schema: segmentExtractionSchema(),
    input: [
      "Extract grounded findings from this voice memo transcript segment.",
      "Every non-empty item must include a short excerpt copied from the source transcript.",
      "Do not invent tasks, claims, projects, examples, or certainty that is not supported by the transcript.",
      "Use empty arrays when nothing grounded exists for a field.",
      "",
      segmentInput(segment),
    ].join("\n"),
  });
}

async function synthesizeTranscript(client, { model, root, segments, records }) {
  const compact = segments.map((segment) => ({
    id: segment.id,
    start: segment.start,
    end: segment.end,
    title: segment.title,
    summary: segment.summary,
    cleanedText: segment.cleanedText,
    itemCounts: Object.fromEntries(
      ITEM_FIELDS.map((field) => [
        field,
        records.find((record) => record.segmentId === segment.id)?.[field]?.length || 0,
      ]),
    ),
  }));

  return callStructured(client, {
    model,
    name: "transcript_synthesis",
    schema: transcriptSynthesisSchema(),
    input: [
      "Create the top-level summary structure for this voice memo package.",
      "Use only the supplied compact segment summaries and extraction counts.",
      "Generate a concise human-readable title for the whole note. Prefer 4-9 words. Use title case only when it reads naturally.",
      "The title should describe the memo's main subject, not the source file, package path, date, or generic phrase like voice memo.",
      "The UI will use sections to organize the raw timestamped transcript, so section titles should be specific and scannable.",
      "",
      `Package: ${root}`,
      JSON.stringify(compact, null, 2),
    ].join("\n"),
  });
}

async function callStructured(client, { model, name, schema, input }) {
  const response = await client.responses.create({
    model,
    input,
    text: {
      format: {
        type: "json_schema",
        name,
        strict: true,
        schema,
      },
    },
  });
  const text = response.output_text || extractOutputText(response);
  if (!text) throw new Error(`OpenAI response for ${name} did not include output text.`);
  const usage = normalizeUsage(response.usage);
  return {
    data: JSON.parse(text),
    usage,
    cost: estimateCost(usage, priceForModel("openai", model)),
  };
}

function extractOutputText(response) {
  const chunks = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (content.type === "output_text" && content.text) chunks.push(content.text);
    }
  }
  return chunks.join("");
}

function normalizeExtractionRecord(segment, extraction) {
  const record = {
    segmentId: segment.id,
    promptVersion: LLM_PROMPT_VERSION,
    start: segment.start,
    end: segment.end,
    sourceFiles: segment.sourceFiles || [],
    claims: normalizeItems(extraction.claims, segment),
    opinions: normalizeItems(extraction.opinions, segment),
    experience: normalizeItems(extraction.experience, segment),
    tasks: normalizeItems(extraction.tasks, segment),
    blogSeeds: normalizeItems(extraction.blogSeeds, segment),
    tweetCandidates: normalizeItems(extraction.tweetCandidates, segment),
    quoteCandidates: normalizeItems(extraction.quoteCandidates, segment),
    voiceMarkers: normalizeItems(extraction.voiceMarkers, segment),
    followUpQuestions: normalizeItems(extraction.followUpQuestions, segment),
    sensitiveFlags: normalizeItems(extraction.sensitiveFlags, segment),
  };
  validateExtractionRecord(record);
  return record;
}

function normalizeItems(items, segment) {
  return (items || [])
    .filter((item) => item?.text)
    .map((item) => ({
      text: item.text.trim(),
      excerpt: String(item.excerpt || "").trim(),
      uncertainty: !!item.uncertainty,
      evidence: evidenceQuality(segment.text || "", item.excerpt || ""),
    }));
}

function validateExtractionRecord(record) {
  for (const field of ITEM_FIELDS) {
    if (!Array.isArray(record[field])) {
      throw new Error(`${record.segmentId}: ${field} must be an array.`);
    }
    for (const [index, item] of record[field].entries()) {
      if (!item.text) throw new Error(`${record.segmentId}: ${field}[${index}] is missing text.`);
      if (!item.excerpt) throw new Error(`${record.segmentId}: ${field}[${index}] is missing excerpt.`);
      if (typeof item.uncertainty !== "boolean") {
        throw new Error(`${record.segmentId}: ${field}[${index}] is missing uncertainty.`);
      }
    }
  }
}

function evidenceQuality(source, excerpt) {
  if (!excerpt.trim()) return "missing";
  if (normalizeSearch(source).includes(normalizeSearch(excerpt))) return "exact";
  const sourceWords = new Set(normalizeSearch(source).split(" ").filter(Boolean));
  const excerptWords = normalizeSearch(excerpt).split(" ").filter((word) => word.length > 3);
  if (!excerptWords.length) return "weak";
  const matched = excerptWords.filter((word) => sourceWords.has(word)).length;
  return matched / excerptWords.length >= 0.65 ? "fuzzy" : "unmatched";
}

function normalizeSummarySections(sections, segments) {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return sections.map((section, index) => {
    const sourceSegmentIds = (section.sourceSegmentIds || []).filter((id) => byId.has(id));
    const sourceSegments = sourceSegmentIds.map((id) => byId.get(id));
    const first = sourceSegments[0] || segments[index] || segments[0];
    const last = sourceSegments.at(-1) || first;
    return {
      title: section.title || first?.title || `Section ${index + 1}`,
      summary: section.summary || first?.summary || "",
      start: section.start || first?.start || fmtTime(0),
      end: section.end || last?.end || fmtTime(0),
      startMs: first?.startMs ?? 0,
      endMs: last?.endMs ?? first?.endMs ?? 0,
      cleanedText: section.cleanedText || sourceSegments.map((segment) => segment.cleanedText || segment.text).join("\n\n"),
      sourceSegmentIds: sourceSegmentIds.length ? sourceSegmentIds : first ? [first.id] : [],
    };
  });
}

function normalizeTitle(title, root) {
  const cleaned = String(title || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return path.basename(root);
  return cleaned.slice(0, 120);
}

function segmentInput(segment) {
  return [
    `Segment ID: ${segment.id}`,
    `Start: ${segment.start}`,
    `End: ${segment.end}`,
    `Source files: ${(segment.sourceFiles || []).join(", ") || "(unknown)"}`,
    "",
    "Transcript:",
    segment.text || "",
  ].join("\n");
}

function segmentRewriteSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "gist", "summary", "cleanedText", "sectionHints"],
    properties: {
      title: { type: "string" },
      gist: { type: "string" },
      summary: { type: "string" },
      cleanedText: { type: "string" },
      sectionHints: {
        type: "array",
        items: { type: "string" },
      },
    },
  };
}

function segmentExtractionSchema() {
  const itemArray = {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["text", "excerpt", "uncertainty"],
      properties: {
        text: { type: "string" },
        excerpt: { type: "string" },
        uncertainty: { type: "boolean" },
      },
    },
  };
  return {
    type: "object",
    additionalProperties: false,
    required: ITEM_FIELDS,
    properties: Object.fromEntries(ITEM_FIELDS.map((field) => [field, itemArray])),
  };
}

function transcriptSynthesisSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "summary", "topBullets", "themes", "sections"],
    properties: {
      title: { type: "string" },
      summary: { type: "string" },
      topBullets: { type: "array", items: { type: "string" } },
      themes: { type: "array", items: { type: "string" } },
      sections: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "summary", "start", "end", "cleanedText", "sourceSegmentIds"],
          properties: {
            title: { type: "string" },
            summary: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            cleanedText: { type: "string" },
            sourceSegmentIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
  };
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

async function writeJsonl(file, records) {
  await fs.writeFile(
    file,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
}

function normalizeSearch(value) {
  return String(value).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
