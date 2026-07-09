import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import dotenv from "dotenv";
import { done, fmtTime, info, step, warn } from "./util.js";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "..");

export const LLM_PROMPT_VERSION = "transcript-llm-analysis@2026-07-03.1";
export const FOLLOW_UP_QUESTIONS_PROMPT_VERSION = "transcript-follow-up-questions@2026-07-08.1";
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
  "sensitiveFlags",
];

const PRICE_SOURCE = {
  provider: "openai",
  url: "https://developers.openai.com/api/docs/pricing",
  retrievedAt: "2026-07-03",
  unit: "usd_per_1m_tokens",
};

const SHARED_TRANSCRIPT_INSTRUCTIONS = [
  "You analyze a full timestamped voice memo transcript.",
  "Treat the transcript message as the stable shared context for all tasks in this run.",
  "Ground every answer in that transcript and preserve timestamp/source references when requested.",
  "Do not invent facts, examples, tasks, opinions, project names, or certainty.",
].join("\n");

const TRANSCRIPT_PLAN_SCHEMA_NAME = "transcript_plan";
const TRANSCRIPT_EXTRACTION_SCHEMA_NAME = "transcript_extraction";
const FOLLOW_UP_QUESTIONS_SCHEMA_NAME = "follow_up_questions";
const DEFAULT_LLM_EXTRACTION_CONCURRENCY = 3;

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
  const sourceSegments = segmentsPayload?.segments || [];
  if (!sourceSegments.length) throw new Error(`No transcript scaffold found for LLM analysis: ${segmentsPath}`);
  const transcript = await readTranscriptContext(root, sourceSegments);

  const startedAt = new Date(parseInt(process.env.V2C_NOW || Date.now(), 10)).toISOString();
  const startedMs = Date.now();
  step(`LLM transcript analysis: ${path.basename(root)}`);
  info(`provider=${provider} model=${model} transcriptItems=${transcript.items.length}`);
  info(`package=${root}`);
  try {
    await fs.rm(errorPath, { force: true });
    info("loading OpenAI client and .env");
    const client = opts.openAIClient || createOpenAIClient(root);
    info("OpenAI client ready");
    const promptCacheKey = promptCacheKeyForTranscript(model, transcript);
    info(`prompt cache key=${promptCacheKey}`);
    const extractionConcurrency = llmExtractionConcurrency(opts);
    const llmUsage = createUsageAccumulator(provider, model);

    info("semantic sectioning start");
    const planCall = await planTranscript(client, { model, root, transcript, promptCacheKey });
    const summary = planCall.data;
    addUsage(llmUsage, planCall);
    const semanticSegments = normalizePlannedSegments(summary.sections || [], transcript, sourceSegments);
    info(`semantic sectioning done: ${semanticSegments.length} section(s) ${formatCallUsage(planCall)}`);

    const record = emptyTranscriptRecord(transcript, sourceSegments);
    const runExtraction = async (field) => {
      info(`extract ${field} start`);
      const extractionCall = await extractTranscriptItems(client, {
        model,
        field,
        transcript,
        segments: semanticSegments,
        promptCacheKey,
      });
      addUsage(llmUsage, extractionCall);
      record[field] = normalizeItems(extractionCall.data.items || [], transcript, semanticSegments);
      info(`extract ${field} done: ${record[field].length} item(s) ${formatCallUsage(extractionCall)}`);
    };

    const [cacheWarmupField, ...parallelFields] = ITEM_FIELDS;
    if (cacheWarmupField) {
      await runExtraction(cacheWarmupField);
    }
    if (parallelFields.length) {
      info(`extract remaining start: ${parallelFields.length} field(s), concurrency=${extractionConcurrency}`);
      await mapWithConcurrency(parallelFields, extractionConcurrency, runExtraction);
    }
    info("follow-up questions start");
    const followUpCall = await generateFollowUpQuestions(client, {
      model,
      transcript,
      segments: semanticSegments,
      promptCacheKey,
    });
    addUsage(llmUsage, followUpCall);
    const followUpQuestions = normalizeFollowUpQuestions(
      followUpCall.data.questions || [],
      transcript,
      semanticSegments,
    );
    info(`follow-up questions done: ${followUpQuestions.length} question(s) ${formatCallUsage(followUpCall)}`);
    validateExtractionRecord(record);
    const records = [record];
    info(`LLM total: ${formatUsageSummary(llmUsage.totals)} ${formatCost(llmUsage.totalCost)}`);

    const updatedSegmentsPayload = {
      ...segmentsPayload,
      promptVersion: LLM_PROMPT_VERSION,
      llmModel: model,
      generatedAt: startedAt,
      segmentation: {
        method: "llm_full_transcript",
        sourceBoundaryAssumption: "Each source audio file is a meaningful input boundary before LLM semantic sectioning.",
      },
      segments: semanticSegments,
    };
    info(`writing ${path.relative(root, segmentsPath)}`);
    await fs.writeFile(segmentsPath, `${JSON.stringify(updatedSegmentsPayload, null, 2)}\n`, "utf8");

    const segmentAnalysisPath = path.join(analysisDir, "segment-analysis.jsonl");
    info(`writing ${path.relative(root, segmentAnalysisPath)}`);
    await writeJsonl(segmentAnalysisPath, records);

    const followUpQuestionsPath = path.join(analysisDir, "follow-up-questions.json");
    info(`writing ${path.relative(root, followUpQuestionsPath)}`);
    await fs.writeFile(
      followUpQuestionsPath,
      `${JSON.stringify(
        {
          promptVersion: FOLLOW_UP_QUESTIONS_PROMPT_VERSION,
          model,
          provider,
          generatedAt: startedAt,
          usage: usageSummaryForJson(llmUsage),
          source: {
            transcript: transcript.source,
            range: { start: transcript.start, end: transcript.end },
          },
          questions: followUpQuestions,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

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
          sections: normalizeSummarySections(semanticSegments),
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
      followUpQuestionsPath,
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

export async function runFollowUpQuestionsAnalysis(packageDir, opts = {}) {
  const root = path.resolve(expandHome(packageDir));
  const analysisDir = path.join(root, "analysis");
  const segmentsPath = path.join(analysisDir, "segments.json");
  const provider = opts.llmProvider || DEFAULT_LLM_PROVIDER;
  const model = opts.llmModel || DEFAULT_LLM_MODEL;

  if (provider !== "openai") {
    throw new Error(`Unsupported LLM provider: ${provider}. Only "openai" is supported.`);
  }

  const segmentsPayload = await readJson(segmentsPath);
  const sourceSegments = segmentsPayload?.segments || [];
  if (!sourceSegments.length) throw new Error(`No transcript sections found for follow-up questions: ${segmentsPath}`);
  const transcript = await readTranscriptContext(root, sourceSegments);
  const segments = sourceSegments.map((segment, index) => ({
    ...plannedSegmentFromSource(segment, index),
    id: segment.id || `seg_${String(index + 1).padStart(3, "0")}`,
    text: segment.text || segment.cleanedText || "",
  }));

  const startedAt = new Date(parseInt(process.env.V2C_NOW || Date.now(), 10)).toISOString();
  const startedMs = Date.now();
  step(`LLM follow-up questions: ${path.basename(root)}`);
  info(`provider=${provider} model=${model} transcriptItems=${transcript.items.length}`);
  await fs.mkdir(analysisDir, { recursive: true });
  const client = opts.openAIClient || createOpenAIClient(root);
  const promptCacheKey = promptCacheKeyForTranscript(model, transcript);
  const call = await generateFollowUpQuestions(client, { model, transcript, segments, promptCacheKey });
  const questions = normalizeFollowUpQuestions(call.data.questions || [], transcript, segments);
  const followUpQuestionsPath = path.join(analysisDir, "follow-up-questions.json");
  await fs.writeFile(
    followUpQuestionsPath,
    `${JSON.stringify(
      {
        promptVersion: FOLLOW_UP_QUESTIONS_PROMPT_VERSION,
        model,
        provider,
        generatedAt: startedAt,
        source: {
          transcript: transcript.source,
          range: { start: transcript.start, end: transcript.end },
        },
        usage: usageSummaryForJson(usageAccumulatorFromCall(provider, model, call)),
        questions,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  done(`Follow-up questions complete in ${formatDuration(Date.now() - startedMs)}`);
  return {
    root,
    model,
    provider,
    followUpQuestionsPath,
    count: questions.length,
    usage: usageSummaryForJson(usageAccumulatorFromCall(provider, model, call)),
  };
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

function llmExtractionConcurrency(opts) {
  const raw = opts.llmExtractionConcurrency ?? process.env.V2C_LLM_EXTRACTION_CONCURRENCY;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_LLM_EXTRACTION_CONCURRENCY;
  return Math.max(1, Math.min(parsed, DEFAULT_LLM_EXTRACTION_CONCURRENCY));
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(items[index], index);
      }
    }),
  );
  return results;
}

function createUsageAccumulator(provider, model) {
  const pricing = priceForModel(provider, model);
  return {
    provider,
    model,
    pricing,
    calls: 0,
    totalCost: pricing ? 0 : null,
    costBreakdown: pricing ? emptyCostBreakdown() : null,
    totals: emptyUsage(),
  };
}

function usageAccumulatorFromCall(provider, model, call) {
  const accumulator = createUsageAccumulator(provider, model);
  addUsage(accumulator, call);
  return accumulator;
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
  if (accumulator.costBreakdown && call.costBreakdown) {
    accumulator.costBreakdown.uncachedInputCost += call.costBreakdown.uncachedInputCost;
    accumulator.costBreakdown.cachedInputCost += call.costBreakdown.cachedInputCost;
    accumulator.costBreakdown.outputCost += call.costBreakdown.outputCost;
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
  return estimateCostBreakdown(usage, pricing)?.totalCost ?? null;
}

function estimateCostBreakdown(usage, pricing) {
  if (!pricing) return null;
  const cachedInputTokens = pricing.cachedInput === null ? 0 : usage.cachedInputTokens;
  const uncachedInputTokens = Math.max(usage.inputTokens - cachedInputTokens, 0);
  const cachedInputCost =
    pricing.cachedInput === null ? 0 : (cachedInputTokens / 1_000_000) * pricing.cachedInput;
  const uncachedInputCost = (uncachedInputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  return {
    uncachedInputTokens,
    cachedInputTokens,
    uncachedInputCost,
    cachedInputCost,
    outputCost,
    totalCost: uncachedInputCost + cachedInputCost + outputCost,
  };
}

function emptyCostBreakdown() {
  return {
    uncachedInputCost: 0,
    cachedInputCost: 0,
    outputCost: 0,
  };
}

function formatCallUsage(call) {
  return `(${formatUsageSummary(call.usage)} ${formatCostBreakdown(call.costBreakdown, call.cost)})`;
}

function formatUsageSummary(usage) {
  const cachedInputTokens = usage.cachedInputTokens || 0;
  const uncachedInputTokens = Math.max((usage.inputTokens || 0) - cachedInputTokens, 0);
  const cacheRate = usage.inputTokens ? cachedInputTokens / usage.inputTokens : 0;
  return [
    `tokens in=${formatCount(usage.inputTokens)}`,
    `cached=${formatCount(cachedInputTokens)} (${formatPercent(cacheRate)})`,
    `uncached=${formatCount(uncachedInputTokens)}`,
    `out=${formatCount(usage.outputTokens)}`,
    `total=${formatCount(usage.totalTokens)}`,
  ].join(", ");
}

function formatCount(value) {
  return Math.round(value).toLocaleString("en-US");
}

function formatCost(cost) {
  if (cost === null) return "cost=unknown";
  if (cost > 0 && cost < 0.01) return `cost=$${cost.toFixed(4)}`;
  return `cost=$${cost.toFixed(2)}`;
}

function formatCostBreakdown(breakdown, totalCost) {
  if (!breakdown) return formatCost(totalCost);
  return [
    formatCost(totalCost),
    `uncached_in=${formatCostValue(breakdown.uncachedInputCost)}`,
    `cached_in=${formatCostValue(breakdown.cachedInputCost)}`,
    `out=${formatCostValue(breakdown.outputCost)}`,
  ].join(", ");
}

function formatCostValue(cost) {
  if (cost === null || cost === undefined) return "unknown";
  if (cost > 0 && cost < 0.01) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

function formatPercent(value) {
  return `${Math.round(value * 100)}%`;
}

function usageSummaryForJson(accumulator) {
  const cachedInputTokens = accumulator.totals.cachedInputTokens;
  const uncachedInputTokens = Math.max(accumulator.totals.inputTokens - cachedInputTokens, 0);
  return {
    provider: accumulator.provider,
    model: accumulator.model,
    calls: accumulator.calls,
    inputTokens: accumulator.totals.inputTokens,
    cachedInputTokens: accumulator.totals.cachedInputTokens,
    uncachedInputTokens,
    cachedInputRatio: accumulator.totals.inputTokens
      ? cachedInputTokens / accumulator.totals.inputTokens
      : 0,
    outputTokens: accumulator.totals.outputTokens,
    totalTokens: accumulator.totals.totalTokens,
    estimatedCostUsd: accumulator.totalCost,
    estimatedCostBreakdownUsd: accumulator.costBreakdown
      ? {
          uncachedInput: accumulator.costBreakdown.uncachedInputCost,
          cachedInput: accumulator.costBreakdown.cachedInputCost,
          output: accumulator.costBreakdown.outputCost,
        }
      : null,
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

async function planTranscript(client, { model, root, transcript, promptCacheKey }) {
  return callStructured(client, {
    model,
    name: "transcript_plan",
    schemaName: TRANSCRIPT_PLAN_SCHEMA_NAME,
    schema: transcriptPlanSchema(),
    promptCacheKey,
    input: cachedTranscriptInput(transcript, [
      "Task: determine the semantic sections for this entire voice memo transcript.",
      "Use the full context to choose boundaries by meaning, not by fixed pauses or cue phrases.",
      "Respect source audio files as meaningful outer boundaries: do not create a section that crosses source files unless the transcript itself clearly spans a continued thought across combined files.",
      "Return a concise package title, summary, top bullets, themes, and ordered sections.",
      "Each section must include start and end timestamps that exist within the transcript range, a specific title, a short summary, and cleanedText for that section.",
      "",
      `Package: ${root}`,
    ]),
  });
}

async function extractTranscriptItems(client, { model, field, transcript, segments, promptCacheKey }) {
  return callStructured(client, {
    model,
    name: `extract_${field}`,
    schemaName: TRANSCRIPT_EXTRACTION_SCHEMA_NAME,
    schema: transcriptExtractionSchema(),
    promptCacheKey,
    input: cachedTranscriptInput(transcript, [
      "Semantic sections:",
      JSON.stringify(segments.map(({ id, title, start, end }) => ({ id, title, start, end })), null, 2),
      "",
      `Task: extract ${field} from the entire transcript.`,
      extractionGuidance(field),
      "Every item must be grounded in transcript text.",
      "Each item must include a short primary excerpt copied from the transcript.",
      "Use supportingQuotes when the same idea is repeated or strengthened by multiple transcript passages.",
      "Do not invent facts, examples, tasks, opinions, project names, or certainty.",
      "Leave items empty when the transcript does not contain grounded entries for this type.",
    ]),
  });
}

async function generateFollowUpQuestions(client, { model, transcript, segments, promptCacheKey }) {
  return callStructured(client, {
    model,
    name: "follow_up_questions",
    schemaName: FOLLOW_UP_QUESTIONS_SCHEMA_NAME,
    schema: followUpQuestionsSchema(),
    promptCacheKey,
    input: cachedTranscriptInput(transcript, [
      "Semantic sections:",
      JSON.stringify(
        segments.map(({ id, title, start, end, summary }) => ({ id, title, start, end, summary })),
        null,
        2,
      ),
      "",
      "Task: generate follow-up questions for this entire transcript in one pass.",
      "Write questions the speaker should answer later to clarify ambiguity, resolve contradictions, or explore adjacent space.",
      "For each question, include the assumed answer that is most supported by the rest of the transcript.",
      "If the transcript supports multiple contradictory readings, include both sides in alternatives instead of choosing one too confidently.",
      "Prefer questions that help future project work, writing, product decisions, or technical implementation.",
      "Assign scope='transcript' for whole-recording questions and scope='section' for questions tied to one semantic section.",
      "Use sectionId only when scope='section'. The sectionId must match one of the semantic section ids.",
      "Every question must include a short excerpt copied from the transcript.",
      "Return no more than 12 total questions, prioritizing the highest leverage gaps.",
    ]),
  });
}

async function callStructured(client, { model, name, schemaName, schema, input, promptCacheKey }) {
  const response = await client.responses.create({
    model,
    input,
    prompt_cache_key: promptCacheKey,
    text: {
      format: {
        type: "json_schema",
        name: schemaName || name,
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
    costBreakdown: estimateCostBreakdown(usage, priceForModel("openai", model)),
  };
}

function cachedTranscriptInput(transcript, taskLines) {
  return [
    {
      role: "developer",
      content: SHARED_TRANSCRIPT_INSTRUCTIONS,
    },
    {
      role: "user",
      content: transcriptPrefix(transcript),
    },
    {
      role: "user",
      content: taskLines.join("\n"),
    },
  ];
}

function promptCacheKeyForTranscript(model, transcript) {
  const hash = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        promptVersion: LLM_PROMPT_VERSION,
        model,
        source: transcript.source,
        start: transcript.start,
        end: transcript.end,
        body: transcript.body,
      }),
    )
    .digest("hex")
    .slice(0, 32);
  return `v2c-transcript-${hash}`;
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

function emptyTranscriptRecord(transcript, sourceSegments) {
  const record = {
    segmentId: "transcript",
    promptVersion: LLM_PROMPT_VERSION,
    start: transcript.start,
    end: transcript.end,
    sourceFiles: [...new Set(sourceSegments.flatMap((segment) => segment.sourceFiles || []))],
  };
  for (const field of ITEM_FIELDS) record[field] = [];
  return record;
}

function normalizeItems(items, transcript, segments) {
  return (items || [])
    .filter((item) => item?.text)
    .map((item) => {
      const excerpt = String(item.excerpt || "").trim();
      const supportingQuotes = (item.supportingQuotes || [])
        .filter((quote) => quote?.excerpt)
        .map((quote) => ({
          excerpt: String(quote.excerpt || "").trim(),
          note: String(quote.note || "").trim(),
          evidence: evidenceQuality(transcript.text, quote.excerpt || ""),
          sourceSegments: sourceSegmentsForExcerpt(segments, quote.excerpt || ""),
        }));
      return {
        text: item.text.trim(),
        excerpt,
        uncertainty: !!item.uncertainty,
        evidence: evidenceQuality(transcript.text, excerpt),
        supportingQuotes,
        sourceSegments: sourceSegmentsForExcerpt(segments, excerpt),
      };
    });
}

function normalizeFollowUpQuestions(items, transcript, segments) {
  const segmentIds = new Set(segments.map((segment) => segment.id));
  return (items || [])
    .filter((item) => item?.question)
    .slice(0, 12)
    .map((item, index) => {
      const excerpt = String(item.excerpt || "").trim();
      const sectionId = segmentIds.has(item.sectionId) ? item.sectionId : "";
      const sourceSegments = sectionId
        ? segments.filter((segment) => segment.id === sectionId).map(sourceSegmentRef)
        : sourceSegmentsForExcerpt(segments, excerpt);
      const primary = sourceSegments[0];
      return {
        id: `follow_up_${String(index + 1).padStart(3, "0")}`,
        scope: item.scope === "section" && sectionId ? "section" : "transcript",
        sectionId,
        question: String(item.question || "").trim(),
        assumedAnswer: String(item.assumedAnswer || "").trim(),
        alternatives: (item.alternatives || []).map((value) => String(value || "").trim()).filter(Boolean),
        rationale: String(item.rationale || "").trim(),
        excerpt,
        evidence: evidenceQuality(transcript.text, excerpt),
        sourceSegments,
        source: {
          segmentId: primary?.segmentId || sectionId || "transcript",
          start: primary?.start || transcript.start,
          end: primary?.end || transcript.end,
        },
      };
    });
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

function sourceSegmentsForExcerpt(segments, excerpt) {
  if (!excerpt.trim()) return [];
  const exact = segments.filter((segment) => normalizeSearch(segment.text || "").includes(normalizeSearch(excerpt)));
  if (exact.length) return exact.map(sourceSegmentRef);
  return segments
    .map((segment) => ({
      segment,
      quality: evidenceQuality(segment.text || "", excerpt),
    }))
    .filter((match) => match.quality === "fuzzy")
    .map((match) => sourceSegmentRef(match.segment));
}

function sourceSegmentRef(segment) {
  return {
    segmentId: segment.id,
    title: segment.title,
    start: segment.start,
    end: segment.end,
  };
}

function normalizeSummarySections(segments) {
  return segments.map((segment) => ({
    title: segment.title,
    summary: segment.summary,
    start: segment.start,
    end: segment.end,
    startMs: segment.startMs,
    endMs: segment.endMs,
    cleanedText: segment.cleanedText || segment.text,
    sourceSegmentIds: [segment.id],
  }));
}

function normalizeTitle(title, root) {
  const cleaned = String(title || "").replace(/\s+/g, " ").trim();
  if (!cleaned) return path.basename(root);
  return cleaned.slice(0, 120);
}

function transcriptPlanSchema() {
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

function transcriptExtractionSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "excerpt", "uncertainty", "supportingQuotes"],
          properties: {
            text: { type: "string" },
            excerpt: { type: "string" },
            uncertainty: { type: "boolean" },
            supportingQuotes: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["excerpt", "note"],
                properties: {
                  excerpt: { type: "string" },
                  note: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  };
}

function followUpQuestionsSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "scope",
            "sectionId",
            "question",
            "assumedAnswer",
            "alternatives",
            "rationale",
            "excerpt",
          ],
          properties: {
            scope: { type: "string", enum: ["transcript", "section"] },
            sectionId: { type: "string" },
            question: { type: "string" },
            assumedAnswer: { type: "string" },
            alternatives: { type: "array", items: { type: "string" } },
            rationale: { type: "string" },
            excerpt: { type: "string" },
          },
        },
      },
    },
  };
}

async function readTranscriptContext(root, sourceSegments) {
  const transcriptPath = path.join(root, "transcript", "transcript.json");
  const transcriptJson = await readJson(transcriptPath);
  const rawItems = transcriptItems(transcriptJson);
  const items = rawItems.length
    ? rawItems.map((item, index) => normalizeTranscriptItem(item, index)).filter((item) => item.text)
    : sourceSegments.map((segment, index) => ({
        index,
        startMs: segment.startMs || 0,
        endMs: segment.endMs || segment.startMs || 0,
        start: segment.start || fmtTime((segment.startMs || 0) / 1000),
        end: segment.end || fmtTime((segment.endMs || segment.startMs || 0) / 1000),
        sourceFile: segment.sourceFiles?.[0] || "",
        text: segment.text || "",
      }));
  if (!items.length) throw new Error(`No transcript items found under ${root}`);
  const text = items.map((item) => item.text).join(" ").replace(/\s+/g, " ").trim();
  return {
    source: rawItems.length ? "transcript/transcript.json" : "analysis/segments.json",
    start: fmtTime((items[0]?.startMs || 0) / 1000),
    end: fmtTime((items.at(-1)?.endMs || items.at(-1)?.startMs || 0) / 1000),
    text,
    items,
    body: items
      .map((item) => `[${item.start} - ${item.end}]${item.sourceFile ? ` (${item.sourceFile})` : ""} ${item.text}`)
      .join("\n"),
  };
}

function transcriptItems(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  return (
    payload.items ||
    payload.transcription ||
    payload.sentences ||
    payload.segments ||
    payload.chunks ||
    payload.results ||
    []
  );
}

function normalizeTranscriptItem(item, index) {
  const startMs = transcriptTimeMs(
    item.startMs ??
      item.offsets?.from ??
      item.start_ms ??
      item.start ??
      item.start_time ??
      item.timestamp?.[0] ??
      item.timestamps?.from ??
      0,
    item.startMs != null || item.offsets?.from != null || item.start_ms != null,
  );
  const endMs = transcriptTimeMs(
    item.endMs ??
      item.offsets?.to ??
      item.end_ms ??
      item.end ??
      item.end_time ??
      item.timestamp?.[1] ??
      item.timestamps?.to ??
      startMs,
    item.endMs != null || item.offsets?.to != null || item.end_ms != null,
  );
  return {
    index,
    startMs,
    endMs: Math.max(endMs, startMs),
    start: fmtTime(startMs / 1000),
    end: fmtTime(Math.max(endMs, startMs) / 1000),
    sourceFile: item.sourceFile || item.source || "",
    text: String(item.text || item.transcript || item.sentence || "").trim(),
  };
}

function transcriptTimeMs(value, alreadyMs) {
  if (typeof value === "number") return alreadyMs ? value : value * 1000;
  if (typeof value === "string" && value.includes(":")) return parseClock(value) ?? 0;
  const parsed = parseFloat(value);
  if (!Number.isFinite(parsed)) return 0;
  return alreadyMs ? parsed : parsed * 1000;
}

function normalizePlannedSegments(sections, transcript, sourceSegments) {
  const fallback = sourceSegments.map((segment, index) => plannedSegmentFromSource(segment, index));
  const planned = sections.length ? sections : fallback;
  return planned.map((section, index) => {
    const startMs = clampMs(parseClock(section.start) ?? fallback[index]?.startMs ?? 0, transcript);
    const endMs = clampMs(parseClock(section.end) ?? fallback[index]?.endMs ?? startMs, transcript);
    const text = textForRange(transcript.items, startMs, Math.max(endMs, startMs));
    const id = `seg_${String(index + 1).padStart(3, "0")}`;
    return {
      id,
      startMs,
      endMs: Math.max(endMs, startMs),
      start: fmtTime(startMs / 1000),
      end: fmtTime(Math.max(endMs, startMs) / 1000),
      title: String(section.title || `Section ${index + 1}`).trim(),
      gist: String(section.summary || "").slice(0, 240),
      summary: String(section.summary || "").trim(),
      sourceFiles: sourceFilesForRange(sourceSegments, startMs, Math.max(endMs, startMs)),
      boundary: {
        kind: "llm_semantic",
        reason: "Boundary chosen by the LLM from the full transcript context.",
      },
      text,
      cleanedText: String(section.cleanedText || text).trim(),
    };
  });
}

function plannedSegmentFromSource(segment, index) {
  return {
    title: segment.title || `Section ${index + 1}`,
    summary: segment.summary || segment.gist || "",
    startMs: segment.startMs || 0,
    endMs: segment.endMs || segment.startMs || 0,
    start: segment.start,
    end: segment.end,
    cleanedText: segment.text || "",
  };
}

function clampMs(ms, transcript) {
  const first = transcript.items[0]?.startMs ?? 0;
  const last = transcript.items.at(-1)?.endMs ?? transcript.items.at(-1)?.startMs ?? first;
  return Math.max(first, Math.min(ms, last));
}

function textForRange(items, startMs, endMs) {
  return items
    .filter((item) => item.endMs >= startMs && item.startMs <= endMs)
    .map((item) => item.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function sourceFilesForRange(sourceSegments, startMs, endMs) {
  const files = sourceSegments
    .filter((segment) => (segment.endMs ?? segment.startMs ?? 0) >= startMs && (segment.startMs ?? 0) <= endMs)
    .flatMap((segment) => segment.sourceFiles || []);
  return [...new Set(files)];
}

function transcriptPrefix(transcript) {
  return [
    "Full timestamped transcript:",
    `Source: ${transcript.source}`,
    `Range: ${transcript.start} - ${transcript.end}`,
    "",
    transcript.body,
  ].join("\n");
}

function extractionGuidance(field) {
  const guidance = {
    claims: "Extract factual or quasi-factual assertions the speaker makes about the world, systems, products, or project state.",
    opinions: "Extract preferences, judgments, evaluations, tradeoffs, and subjective conclusions.",
    experience: "Extract first-person experience, observed workflow, prior use, or remembered project history.",
    tasks: "Extract concrete actions, implementation ideas, decisions to make, or follow-up work.",
    blogSeeds: "Extract ideas that could become durable essays, posts, or project notes.",
    tweetCandidates: "Extract concise standalone observations that could work as short public notes.",
    quoteCandidates: "Extract memorable phrases worth preserving close to the speaker's wording.",
    voiceMarkers: "Extract patterns in speaking style, uncertainty, recurring framing, or transcript-quality caveats.",
    followUpQuestions: "Extract questions that should be answered to clarify or advance the work.",
    sensitiveFlags: "Extract privacy, security, credential, workplace, personal, or policy-sensitive concerns.",
  };
  return guidance[field] || `Extract ${field}.`;
}

function parseClock(value) {
  if (!value || typeof value !== "string") return undefined;
  const parts = value.replace(",", ".").split(":");
  if (parts.length !== 3) return undefined;
  const [hours, minutes, seconds] = parts;
  return Number(hours) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1000;
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
