import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { continueAnalysisPackage, runFollowUpQuestionsAnalysis } from "../cli/analysis.js";
import { run } from "../cli/pipeline.js";

export default defineConfig({
  plugins: [solid(), voiceMemosApi()],
});

const VOICE_MEMOS_ROOT =
  process.env.V2C_VOICE_MEMOS_ROOT || path.join(os.homedir(), ".v2c-voice-memos");
let voiceMemosRefreshPromise = null;
let voiceMemosRunLlmRemainingPromise = null;

function voiceMemosApi() {
  return {
    name: "v2ctx-voice-memos-api",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        try {
          if (url.pathname === "/api/voice-memos") {
            const library = await readVoiceMemosLibrary();
            sendJson(res, library);
            return;
          }

          if (url.pathname === "/api/voice-memos/refresh") {
            if (req.method !== "POST") {
              sendJson(res, { error: "Method not allowed" }, 405);
              return;
            }
            const requestStarted = Date.now();
            console.log("[v2ctx-ui] voice memo refresh requested");
            if (!voiceMemosRefreshPromise) {
              voiceMemosRefreshPromise = run(["voice-memos", "--no-open"]).finally(() => {
                voiceMemosRefreshPromise = null;
              });
            } else {
              console.log("[v2ctx-ui] joining in-flight voice memo refresh");
            }
            await voiceMemosRefreshPromise;
            const library = await readVoiceMemosLibrary();
            console.log(
              `[v2ctx-ui] voice memo refresh complete in ${formatDuration(Date.now() - requestStarted)}`,
            );
            sendJson(res, { library });
            return;
          }

          if (url.pathname === "/api/voice-memos/run-llm-remaining") {
            if (req.method !== "POST") {
              sendJson(res, { error: "Method not allowed" }, 405);
              return;
            }
            const requestStarted = Date.now();
            console.log("[v2ctx-ui] run-llm remaining requested");
            if (voiceMemosRefreshPromise) {
              console.log("[v2ctx-ui] waiting for in-flight voice memo refresh before run-llm remaining");
              await voiceMemosRefreshPromise;
            }
            if (!voiceMemosRunLlmRemainingPromise) {
              voiceMemosRunLlmRemainingPromise = run(["voice-memos", "--no-open", "--run-llm"]).finally(() => {
                voiceMemosRunLlmRemainingPromise = null;
              });
            } else {
              console.log("[v2ctx-ui] joining in-flight run-llm remaining");
            }
            await voiceMemosRunLlmRemainingPromise;
            const library = await readVoiceMemosLibrary();
            console.log(
              `[v2ctx-ui] run-llm remaining complete in ${formatDuration(Date.now() - requestStarted)}`,
            );
            sendJson(res, { library });
            return;
          }

          const runLlmMatch = /^\/api\/voice-memos\/([^/]+)\/run-llm$/.exec(url.pathname);
          if (runLlmMatch) {
            if (req.method !== "POST") {
              sendJson(res, { error: "Method not allowed" }, 405);
              return;
            }
            const requestStarted = Date.now();
            const packageDir = packageDirForName(decodeURIComponent(runLlmMatch[1]));
            console.log(`[v2ctx-ui] run-llm requested for ${path.basename(packageDir)}`);
            const result = await continueAnalysisPackage(packageDir, {
              runLlm: true,
              derive: true,
            });
            const memoPackage = await readPackage(packageDir);
            console.log(
              `[v2ctx-ui] run-llm complete for ${path.basename(packageDir)} in ${formatDuration(
                Date.now() - requestStarted,
              )}`,
            );
            sendJson(res, { result, package: memoPackage });
            return;
          }

          const rerunQuestionsMatch = /^\/api\/voice-memos\/([^/]+)\/rerun-follow-up-questions$/.exec(url.pathname);
          if (rerunQuestionsMatch) {
            if (req.method !== "POST") {
              sendJson(res, { error: "Method not allowed" }, 405);
              return;
            }
            const requestStarted = Date.now();
            const packageDir = packageDirForName(decodeURIComponent(rerunQuestionsMatch[1]));
            console.log(`[v2ctx-ui] follow-up question rerun requested for ${path.basename(packageDir)}`);
            const result = await runFollowUpQuestionsAnalysis(packageDir);
            const memoPackage = await readPackage(packageDir);
            console.log(
              `[v2ctx-ui] follow-up question rerun complete for ${path.basename(packageDir)} in ${formatDuration(
                Date.now() - requestStarted,
              )}`,
            );
            sendJson(res, { result, package: memoPackage });
            return;
          }

          const waveformMatch = /^\/api\/voice-memos\/([^/]+)\/waveform$/.exec(url.pathname);
          if (waveformMatch) {
            await handleWaveformCache(req, res, decodeURIComponent(waveformMatch[1]));
            return;
          }

          if (url.pathname.startsWith("/api/asset/")) {
            await sendAsset(url, req, res);
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown server error";
          console.error(`[v2ctx-ui] API error: ${message}`);
          sendJson(res, { error: message }, 500);
          return;
        }
        next();
      });
    },
  };
}

async function readVoiceMemosLibrary() {
  const packageDirs = await findPackageDirs(VOICE_MEMOS_ROOT);
  const packages = await Promise.all(packageDirs.map((packageDir) => readPackage(packageDir)));
  return {
    root: VOICE_MEMOS_ROOT,
    generatedAt: new Date().toISOString(),
    packages: packages.sort((a, b) => b.name.localeCompare(a.name)),
  };
}

async function findPackageDirs(root) {
  const entries = await fsp.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith("-context"))
    .map((entry) => path.join(root, entry.name));
}

async function readPackage(packageDir) {
  const isRootPackage = path.resolve(packageDir) === path.resolve(VOICE_MEMOS_ROOT);
  const name = isRootPackage ? "voice-memos-root" : path.basename(packageDir);
  const files = await listPackageFiles(packageDir);
  const manifest = await readJson(path.join(packageDir, ".v2c-manifest.json"));
  const segmentsPayload = await readJson(path.join(packageDir, "analysis", "segments.json"));
  const transcriptPayload = await readJson(path.join(packageDir, "transcript", "transcript.json"));
  const transcriptSummary = await readJson(path.join(packageDir, "analysis", "transcript-summary.json"));
  const followUpQuestions = await readJson(path.join(packageDir, "analysis", "follow-up-questions.json"));
  const reviewItems = (await readJsonl(path.join(packageDir, "analysis", "review-inbox.jsonl"))).map(
    (item) => ({
      ...item,
      id: `${name}::${item.id}`,
      source: {
        ...item.source,
        packageName: name,
        package: packageDir,
        source: item.source?.source ?? item.source?.sourceFiles?.[0],
      },
    }),
  );
  const audio = findFirst(files, ["audio/audio.wav", "audio/audio.m4a", "audio/audio.mp3"]);
  const report = files.find((file) => file.path === "report.html");

  return {
    name,
    title: packageTitle(name, transcriptSummary),
    files,
    manifest,
    reviewItems,
    transcriptSummary,
    followUpQuestions: normalizeFollowUpQuestions(followUpQuestions),
    segments: segmentsPayload?.segments ?? [],
    transcript: normalizeTranscript(transcriptItems(transcriptPayload)),
    audio,
    report,
    status: inferStatus(files),
  };
}

function normalizeFollowUpQuestions(payload) {
  if (!payload || !Array.isArray(payload.questions)) return undefined;
  return {
    ...payload,
    questions: payload.questions
      .filter((item) => item && typeof item.question === "string")
      .map((item) => ({
        ...item,
        alternatives: Array.isArray(item.alternatives) ? item.alternatives : [],
      })),
  };
}

function packageTitle(name, transcriptSummary) {
  const title = transcriptSummary?.title;
  return typeof title === "string" && title.trim() ? title.trim() : name;
}

async function listPackageFiles(packageDir) {
  const isRootPackage = path.resolve(packageDir) === path.resolve(VOICE_MEMOS_ROOT);
  const output = [];
  async function visit(dir) {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".DS_Store") continue;
      const fullPath = path.join(dir, entry.name);
      if (isRootPackage && dir === packageDir && entry.isDirectory() && entry.name.endsWith("-context")) {
        continue;
      }
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      const relativePath = path.relative(packageDir, fullPath);
      const stat = await fsp.stat(fullPath);
      output.push({
        path: relativePath,
        size: stat.size,
        mtimeMs: Math.trunc(stat.mtimeMs),
        url: `/api/asset/${encodeURIComponent(isRootPackage ? "voice-memos-root" : path.basename(packageDir))}/${relativePath
          .split(path.sep)
          .map(encodeURIComponent)
          .join("/")}`,
      });
    }
  }
  await visit(packageDir);
  return output.sort((a, b) => a.path.localeCompare(b.path));
}

async function sendAsset(url, req, res) {
  const parts = url.pathname.replace("/api/asset/", "").split("/").map(decodeURIComponent);
  const packageName = parts.shift();
  if (
    !packageName ||
    (packageName !== "voice-memos-root" && !packageName.endsWith("-context")) ||
    parts.length === 0
  ) {
    sendJson(res, { error: "Invalid asset path" }, 400);
    return;
  }

  const packageDir =
    packageName === "voice-memos-root" ? VOICE_MEMOS_ROOT : path.join(VOICE_MEMOS_ROOT, packageName);
  const filePath = path.resolve(packageDir, ...parts);
  const safeRoot = `${path.resolve(packageDir)}${path.sep}`;
  if (!filePath.startsWith(safeRoot)) {
    sendJson(res, { error: "Invalid asset path" }, 400);
    return;
  }

  const stat = await fsp.stat(filePath);
  const range = req.headers.range;
  const contentType = contentTypeFor(filePath);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType);

  if (range) {
    const match = /bytes=(\d+)-(\d*)/.exec(range);
    if (!match) {
      res.statusCode = 416;
      res.end();
      return;
    }
    const start = Number(match[1]);
    const end = match[2] ? Number(match[2]) : stat.size - 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    res.setHeader("Content-Length", String(end - start + 1));
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.setHeader("Content-Length", String(stat.size));
  fs.createReadStream(filePath).pipe(res);
}

function inferStatus(files) {
  const has = (suffix) => files.some((file) => file.path.endsWith(suffix));
  if (has("analysis/review-inbox.jsonl")) return "derived";
  if (has("analysis/segment-analysis.jsonl")) return "analysis_ready";
  if (has("analysis/llm-error.json")) return "llm_failed";
  if (has("analysis/segments.json")) return "segments_ready";
  if (has("transcript/transcript.json") || has("transcript/transcript.txt")) return "transcribed";
  return "new";
}

function packageDirForName(packageName) {
  if (packageName === "voice-memos-root") return VOICE_MEMOS_ROOT;
  if (!packageName.endsWith("-context") || packageName.includes("/") || packageName.includes("\\")) {
    throw new Error("Invalid package name");
  }
  const packageDir = path.resolve(VOICE_MEMOS_ROOT, packageName);
  const safeRoot = `${path.resolve(VOICE_MEMOS_ROOT)}${path.sep}`;
  if (!packageDir.startsWith(safeRoot)) throw new Error("Invalid package name");
  return packageDir;
}

async function handleWaveformCache(req, res, packageName) {
  const packageDir = packageDirForName(packageName);
  const cachePath = path.join(packageDir, "analysis", "waveform.json");

  if (req.method === "GET") {
    const cache = await readJson(cachePath);
    if (!cache) {
      sendJson(res, { error: "Waveform cache not found" }, 404);
      return;
    }
    sendJson(res, cache);
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, { error: "Method not allowed" }, 405);
    return;
  }

  const payload = await readRequestJson(req, 1_000_000);
  if (!isValidWaveformCache(payload)) {
    sendJson(res, { error: "Invalid waveform cache" }, 400);
    return;
  }

  await fsp.mkdir(path.dirname(cachePath), { recursive: true });
  await fsp.writeFile(cachePath, `${JSON.stringify(payload)}\n`);
  sendJson(res, { ok: true });
}

async function readRequestJson(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function isValidWaveformCache(value) {
  return (
    value &&
    value.version === 1 &&
    value.audio &&
    typeof value.audio.url === "string" &&
    (value.audio.size == null || Number.isFinite(value.audio.size)) &&
    (value.audio.mtimeMs == null || Number.isFinite(value.audio.mtimeMs)) &&
    Number.isFinite(value.durationMs) &&
    value.durationMs > 0 &&
    Array.isArray(value.samples) &&
    value.samples.length > 0 &&
    value.samples.length <= 10_000 &&
    value.samples.every((sample) => Number.isFinite(sample) && sample >= 0 && sample <= 1)
  );
}

function findFirst(files, paths) {
  return files.find((file) => paths.some((candidate) => file.path.endsWith(candidate)));
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonl(filePath) {
  try {
    return (await fsp.readFile(filePath, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeTranscript(items) {
  return items.map((item) => ({
    ...item,
    startMs: item.startMs ?? item.offsets?.from ?? parseClock(item.timestamps?.from) ?? secondsToMs(item.start),
    endMs: item.endMs ?? item.offsets?.to ?? parseClock(item.timestamps?.to) ?? secondsToMs(item.end),
  }));
}

function transcriptItems(payload) {
  if (!payload) return [];
  return (
    payload.items ||
    payload.transcription ||
    payload.sentences ||
    payload.segments ||
    payload.chunks ||
    payload.results ||
    (Array.isArray(payload) ? payload : [])
  );
}

function parseClock(value) {
  if (!value) return undefined;
  const parts = value.replace(",", ".").split(":");
  if (parts.length !== 3) return undefined;
  return Number(parts[0]) * 3_600_000 + Number(parts[1]) * 60_000 + Number(parts[2]) * 1000;
}

function secondsToMs(value) {
  if (value == null || Number.isNaN(value)) return undefined;
  return value * 1000;
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".json" || ext === ".jsonl") return "application/json; charset=utf-8";
  if (ext === ".md" || ext === ".txt" || ext === ".srt") return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

function sendJson(res, payload, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}
