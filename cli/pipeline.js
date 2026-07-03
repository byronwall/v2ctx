import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ensureLocalTools, findFfmpeg, findParakeet, findWhisper } from "./tools.js";
import { ensureModel } from "./models.js";
import { resolveInputs, buildTimeline } from "./sources.js";
import { buildContactSheet } from "./contact.js";
import { parseTranscript, writeIndex, writeHtmlReport } from "./report.js";
import { exec, log, step, done, info, warn, fmtTime } from "./util.js";
import {
  analyzePackage,
  continueAnalysisPackage,
  deriveArtifacts,
  DEFAULT_LLM_MODEL,
  DEFAULT_LLM_PROVIDER,
  defaultVoiceMemoOutput,
  getPackageStatus,
  importCodexResults,
  resetAnalysisAssets,
} from "./analysis.js";

const HELP = `
video-to-context — turn screen recordings or audio memos into a structured,
digestible context package (transcript + screenshots when video is present +
contact sheet + HTML report) using local FFmpeg and Parakeet/whisper.cpp.
Optional transcript analysis uses the OpenAI API only when --run-llm is passed.

USAGE
  video-to-context <command> [options]
  video-to-context [input] [options]
  v2c [input] [options]

  input may be a media FILE, a DIRECTORY (all eligible media in it are
  concatenated into one timeline with lineage back to each source), or omitted
  (defaults to the current directory).

COMMANDS
  voice-memos                Main workflow: process new Apple Voice Memos,
                             run LLM analysis when requested, and skip completed ones
  analyze <context-package>  Create analysis/segments.json and
                             analysis/session-digest.md from a transcript
  analyze --voice-memos      Process new/unprocessed Apple Voice Memos, then
                             analyze them

OPTIONS
  -o, --output <dir>     Output directory (default: <name>-context)
      --transcriber <t>  Audio transcription backend: parakeet or whisper
                         (default: parakeet)
  -m, --model <name>     Whisper-only model: tiny(.en) base(.en) small(.en)
                         medium(.en) large-v3 large-v3-turbo, or a path to a
                         ggml-*.bin file (default: base.en)
      --decoding <mode>  Parakeet decoding mode, e.g. greedy or beam
      --beam-size <n>    Parakeet beam size when using beam decoding
  -l, --language <code>  Spoken language hint, e.g. en (default: auto)
      --interval <sec>   Seconds between screenshots (default: 10)
      --scene [thresh]   Scene-change detection instead of fixed interval
                         (threshold 0..1, default 0.08)
      --contact <n>      Frames in the contact sheet (default: 25; 0 disables)
      --voice-memos      Auto-detect Apple Voice Memos, write to
                         ~/.v2c-voice-memos, skip visuals/source copies, open
                         report.html when done
      --prepare-codex    Advanced: write analysis/codex prompt packets
      --codex-model <m>  Override Codex model (default: gpt-5.4-mini)
      --force-analysis   With analyze, rebuild existing analysis files
      --reset-analysis   Delete analysis assets before continuing
      --import-codex     Advanced: validate and install Codex JSONL results
      --from <jsonl>     With --import-codex, source JSONL to import
      --derive           Advanced: derive tasks/claims/quotes/blog/review
      --run-llm          Run provider-backed transcript analysis
      --llm-provider <p> LLM provider (default: openai)
      --llm-model <m>    LLM model (default: gpt-5.5)
      --run-codex        With analyze, run Codex on prepared packets
      --no-codex         In voice-memos, stop after preparing Codex packets
      --open             Open report.html when done
      --no-open          Don't open report.html
      --no-source        Don't copy source media into the package
      --no-frames        Skip screenshot extraction
      --no-transcript    Skip transcription
  -y, --yes              Answer yes to dependency installation prompts
  -f, --force            Overwrite an existing output directory
  -h, --help             Show this help

Reruns are idempotent: if the output directory already contains a matching
.v2c-manifest.json for the same input files and options, the CLI prints the
existing outputs and exits without transcribing again. Use --force to rebuild.

EXAMPLES
  video-to-context voice-memos           # main workflow for new Voice Memos
  video-to-context voice-memos --run-llm # process transcripts with OpenAI
  video-to-context voice-memos --transcriber whisper -m medium
  video-to-context voice-memos --force  # reprocess audio + transcript
  video-to-context voice-memos --reset-analysis
  video-to-context voice-memos --no-codex # prepare packets, don't run model
  video-to-context analyze ./demo-context --run-llm --derive
  video-to-context analyze ./demo-context --prepare-codex --run-codex --derive
  video-to-context analyze ./demo-context --import-codex --from ./results/segment-analysis.jsonl --derive
  video-to-context analyze ./demo-context --prepare-codex
  video-to-context --voice-memos         # Apple Voice Memos → ~/.v2c-voice-memos
  video-to-context                       # all media files in the current folder
  video-to-context demo.mov
  video-to-context ~/Library/Mobile\\ Documents/com~apple~CloudDocs/Voice\\ Memos -o ~/Documents/voice-memos-context
  video-to-context ~/Desktop --transcriber whisper -m medium
  video-to-context demo.mov --scene 0.05 -o ./demo-context
`;

function parseArgs(argv) {
  const opts = {
    input: null,
    output: null,
    transcriber: "parakeet",
    model: "base.en",
    language: null,
    decoding: null,
    beamSize: null,
    interval: 10,
    scene: null,
    contact: 25,
    copySource: true,
    frames: true,
    transcript: true,
    voiceMemos: false,
    openReport: false,
    recursive: false,
    force: false,
    yes: false,
    codexModel: null,
    from: null,
    runCodex: null,
    resetAnalysis: false,
    runLlm: false,
    llmProvider: DEFAULT_LLM_PROVIDER,
    llmModel: DEFAULT_LLM_MODEL,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "-o":
      case "--output":
        opts.output = next();
        break;
      case "-m":
      case "--model":
        opts.model = next();
        break;
      case "--transcriber":
        opts.transcriber = next();
        break;
      case "-l":
      case "--language":
        opts.language = next();
        break;
      case "--decoding":
        opts.decoding = next();
        break;
      case "--beam-size":
        opts.beamSize = parseInt(next(), 10);
        break;
      case "--interval":
        opts.interval = parseFloat(next());
        break;
      case "--contact":
        opts.contact = parseInt(next(), 10);
        break;
      case "--voice-memos":
        opts.voiceMemos = true;
        break;
      case "--prepare-codex":
        opts.prepareCodex = true;
        break;
      case "--codex-model":
        opts.codexModel = next();
        break;
      case "--force-analysis":
        opts.forceAnalysis = true;
        break;
      case "--reset-analysis":
        opts.resetAnalysis = true;
        break;
      case "--import-codex":
        opts.importCodex = true;
        break;
      case "--from":
        opts.from = next();
        break;
      case "--derive":
        opts.derive = true;
        break;
      case "--run-llm":
        opts.runLlm = true;
        break;
      case "--llm-provider":
        opts.llmProvider = next();
        break;
      case "--llm-model":
        opts.llmModel = next();
        break;
      case "--run-codex":
        opts.runCodex = true;
        break;
      case "--no-codex":
        opts.runCodex = false;
        break;
      case "--open":
        opts.openReport = true;
        break;
      case "--no-open":
        opts.openReport = false;
        opts.noOpen = true;
        break;
      case "--scene": {
        const peek = argv[i + 1];
        opts.scene = peek && !peek.startsWith("-") ? parseFloat(next()) : 0.08;
        break;
      }
      case "--no-source":
        opts.copySource = false;
        break;
      case "--no-frames":
        opts.frames = false;
        break;
      case "--no-transcript":
        opts.transcript = false;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "-f":
      case "--force":
        opts.force = true;
        break;
      default:
        if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
        if (opts.input) throw new Error(`Unexpected argument: ${a}`);
        opts.input = a;
    }
  }
  if (!["parakeet", "whisper"].includes(opts.transcriber)) {
    throw new Error(`Unknown transcriber: ${opts.transcriber}. Use "parakeet" or "whisper".`);
  }
  if (opts.llmProvider !== "openai") {
    throw new Error(`Unknown LLM provider: ${opts.llmProvider}. Use "openai".`);
  }
  return opts;
}

export async function run(argv) {
  const command = argv[0];
  if (command === "analyze") {
    await runAnalyze(argv.slice(1));
    return;
  }
  if (command === "voice-memos") {
    const opts = parseArgs(argv.slice(1));
    opts.voiceMemos = true;
    await runVoiceMemos(opts);
    return;
  }

  const opts = parseArgs(argv);
  if (opts.help) {
    log(HELP);
    return;
  }
  await runCapture(opts);
}

async function runAnalyze(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    log(HELP);
    return;
  }
  if (opts.voiceMemos) {
    await runVoiceMemos(opts);
    return;
  }
  if (!opts.input) {
    throw new Error("Usage: v2c analyze <context-package> [--prepare-codex]");
  }

  if (opts.resetAnalysis) {
    step(`Resetting analysis assets for ${opts.input}`);
    const reset = await resetAnalysisAssets(opts.input);
    done(reset.analysisDir);
    opts.forceAnalysis = true;
  }

  if (opts.importCodex) {
    step(`Importing Codex results for ${opts.input}`);
    const imported = await importCodexResults(opts.input, opts);
    done(`${imported.count} record(s) validated and installed`);
    log(`  codex_result   ${imported.codexResultPath}`);
    log(`  analysis       ${imported.analysisPath}`);
  }

  step(`Analyzing ${opts.input}`);
  const result = await analyzePackage(opts.input, opts);
  done(result.skipped ? "already analyzed" : `${result.count} segment(s)`);
  log(`\n\x1b[1mAnalysis files:\x1b[0m`);
  log(`  segments       ${result.segmentsPath}`);
  log(`  digest         ${result.digestPath}`);
  if (opts.prepareCodex) log(`  codex_packets  ${result.codexDir}`);
  log("");

  if (opts.runCodex === true && opts.prepareCodex) {
    step(`Continuing Codex analysis for ${opts.input}`);
    const continued = await continueAnalysisPackage(opts.input, opts);
    done(`${continued.actions.join(", ") || "already complete"}`);
    return;
  }

  if (opts.runLlm) {
    step(`Running LLM transcript analysis for ${opts.input}`);
    const continued = await continueAnalysisPackage(opts.input, opts);
    done(`${continued.actions.join(", ") || "already complete"}`);
    if (continued.status.stage !== "derived") {
      warn(`${opts.input} waiting at ${continued.status.stage}`);
      info(`next: ${describeNextAction(opts.input, continued.status)}`);
    }
    return;
  }

  if (opts.derive) {
    step(`Deriving artifacts for ${opts.input}`);
    const derived = await deriveArtifacts(opts.input);
    done(
      `${derived.tasks} task(s), ${derived.claims} claim(s), ${derived.quotes} quote(s)`,
    );
    log(`\n\x1b[1mDerived files:\x1b[0m`);
    for (const file of derived.files) log(`  ${file}`);
    log("");
  }
}

async function runVoiceMemos(opts) {
  if (opts.help) {
    log(HELP);
    return;
  }
  step("Locating Apple Voice Memos");
  const input = opts.input ? expandHome(opts.input) : await findVoiceMemosDir();
  const outputRoot = path.resolve(expandHome(opts.output) || defaultVoiceMemoOutput());
  done(input);

  step("Finding voice memo media files");
  const { media } = await resolveInputs(input, {
    recursive: true,
    onProgress: (event) => {
      if (event.type === "scan") info(`scanned ${event.dirs} folder(s); now ${event.dir}`);
      else if (event.type === "media") info(`found ${event.files} media file(s) under ${event.dir}`);
    },
  });
  done(`${media.length} memo file(s)`);

  await fs.mkdir(outputRoot, { recursive: true });
  const processed = [];
  const completed = [];
  const waiting = [];
  const failed = [];
  for (const file of media) {
    const packageDir = uniquePackageDir(outputRoot, file);
    try {
      const before = await getPackageStatus(packageDir);
      const needsLlmSummary = opts.runLlm && !before.exists.transcriptSummary;
      if (
        before.stage === "derived" &&
        !needsLlmSummary &&
        !opts.force &&
        !opts.forceAnalysis &&
        !opts.resetAnalysis
      ) {
        info(`${path.basename(packageDir)}: complete`);
        completed.push(packageDir);
        continue;
      }

      if (before.stage === "new" || opts.force) {
        step(`Transcribing ${path.basename(file)}`);
        await runCapture({
          ...opts,
          input: file,
          output: packageDir,
          voiceMemos: false,
          copySource: false,
          frames: false,
          contact: 0,
          recursive: false,
          openReport: false,
          noOpen: true,
        });
      } else {
        step(`Continuing ${path.basename(packageDir)} (${before.stage})`);
      }

      if (opts.resetAnalysis) {
        step(`Resetting analysis assets for ${path.basename(packageDir)}`);
        await resetAnalysisAssets(packageDir);
        opts.forceAnalysis = true;
      }

      const result = await continueAnalysisPackage(packageDir, opts);
      const after = result.status;
      if (after.stage === "derived") {
        done(`${path.basename(packageDir)} complete: ${result.actions.join(", ") || "no work"}`);
        processed.push(packageDir);
      } else {
        warn(`${path.basename(packageDir)} waiting at ${after.stage}`);
        info(`next: ${describeNextAction(packageDir, after)}`);
        waiting.push(packageDir);
      }
    } catch (err) {
      warn(`${path.basename(packageDir)} failed: ${err.message}`);
      failed.push({ packageDir, error: err.message });
    }
  }

  log(`\n\x1b[32m✓ Done.\x1b[0m  Voice memo packages at:\n  ${outputRoot}\n`);
  log(`\x1b[1mSummary:\x1b[0m`);
  log(`  advanced        ${processed.length}`);
  log(`  complete        ${completed.length}`);
  log(`  waiting         ${waiting.length}`);
  log(`  failed          ${failed.length}`);
  if (waiting.length) {
    log(`\n\x1b[1mWaiting packages:\x1b[0m`);
    for (const packageDir of waiting) {
      const status = await getPackageStatus(packageDir);
      log(`  ${path.basename(packageDir).padEnd(38)} ${status.stage} → ${describeNextAction(packageDir, status)}`);
    }
  }
  if (failed.length) {
    log(`\n\x1b[1mFailed packages:\x1b[0m`);
    for (const item of failed) log(`  ${path.basename(item.packageDir)}: ${item.error}`);
  }
  log("");
}

async function runCapture(opts) {
  step("Checking local tools");
  await ensureLocalTools({
    transcript: opts.transcript,
    transcriber: opts.transcriber,
    yes: opts.yes,
  });
  const { ffmpeg, ffprobe } = await findFfmpeg();
  done(`ffmpeg: ${ffmpeg}`);
  const transcriber = opts.transcript ? await findTranscriber(opts.transcriber) : null;
  if (transcriber) done(`${transcriber.label}: ${transcriber.path}`);

  await applyVoiceMemosPreset(opts);

  // 0. Resolve tools first so we fail fast with install hints.
  if (opts.voiceMemos) {
    log(`\n\x1b[1mvideo-to-context\x1b[0m  voice memos preset`);
    info(`input: ${opts.input}`);
    info(`output: ${opts.output}`);
  }

  // 1. Resolve inputs → ordered source list → combined timeline.
  step(`Finding media files${opts.recursive ? " recursively" : ""}`);
  const { mode, dir, media } = await resolveInputs(expandHome(opts.input), {
    recursive: opts.recursive,
    onProgress: opts.voiceMemos
      ? (event) => {
          if (event.type === "scan") {
            info(`scanned ${event.dirs} folder(s); now ${event.dir}`);
          } else if (event.type === "media") {
            info(`found ${event.files} media file(s) under ${event.dir}`);
          }
        }
      : null,
  });
  done(`${media.length} media file(s) found in ${dir}`);

  step("Reading media metadata");
  const { sources, totalDuration } = await buildTimeline(ffprobe, media, {
    onProgress: opts.voiceMemos
      ? ({ index, total, path: file }) => {
          if (file) info(`probing ${index + 1}/${total}: ${path.basename(file)}`);
          else info(`probed ${total}/${total} file(s)`);
        }
      : null,
  });
  done(`${sources.length} source(s), ${fmtTime(totalDuration)} total`);
  const audioSources = sources.filter((s) => s.hasAudio);
  const videoSources = sources.filter((s) => s.hasVideo);
  const hasAudio = audioSources.length > 0;
  const hasVideo = videoSources.length > 0;
  const noAudioWarning = opts.transcript
    ? "No audio stream was found, so no transcript is available."
    : "No audio stream was found; skipping audio output.";
  const transcriptUnavailable =
    opts.transcript && !hasAudio ? noAudioWarning : null;

  const title =
    mode === "file"
      ? path.basename(media[0], path.extname(media[0]))
      : path.basename(dir);
  const outDir = path.resolve(expandHome(opts.output) || `${title}-context`);
  const dirs = {
    root: outDir,
    source: path.join(outDir, "source"),
    audio: path.join(outDir, "audio"),
    frames: path.join(outDir, "frames"),
    transcript: path.join(outDir, "transcript"),
  };
  const manifestPath = path.join(outDir, ".v2c-manifest.json");
  const runManifest = await buildRunManifest({
    mode,
    dir,
    media,
    sources,
    totalDuration,
    opts,
  });

  const exists = await fs
    .stat(outDir)
    .then(() => true)
    .catch(() => false);
  if (exists) {
    const previous = await readJson(manifestPath);
    if (previous && !opts.force && sameManifest(previous, runManifest)) {
      log(`\n\x1b[1mvideo-to-context\x1b[0m  →  ${outDir}`);
      info("Inputs and options match the existing context package; skipping.");
      await printManifest({
        outDir,
        dirs,
        sources,
        frames: [],
        opts,
        contactSheetFile: previous.outputs?.contactSheetFile || null,
        audioPath: path.join(dirs.audio, "audio.wav"),
        hasAudio,
      });
      await openReportIfRequested(opts.openReport, outDir);
      return;
    }

    if (previous && sameManifest(previous, runManifest)) {
      info("Rebuilding unchanged context package because --force was provided.");
    } else if (previous) {
      info("Input files or options changed; rebuilding existing context package.");
    } else if (!opts.force) {
      throw new Error(
        `Output directory already exists and is not a video-to-context package: ${outDir}\nUse --force to overwrite it, or -o to choose another.`,
      );
    }
    await fs.rm(outDir, { recursive: true, force: true });
  }

  for (const d of Object.values(dirs)) await fs.mkdir(d, { recursive: true });

  log(`\n\x1b[1mvideo-to-context\x1b[0m  →  ${outDir}`);
  if (sources.length > 1) {
    info(`${sources.length} sources, ${fmtTime(totalDuration)} combined:`);
    for (const s of sources) {
      info(
        `  ${s.index + 1}. ${s.name}  (${fmtTime(s.duration)} @ ${fmtTime(s.offset)})`,
      );
    }
  }
  log("");

  if (opts.transcript && hasAudio && opts.transcriber === "whisper") {
    step("Preparing whisper.cpp");
  }
  const modelPath =
    opts.transcript && hasAudio && opts.transcriber === "whisper"
      ? await ensureModel(opts.model)
      : null;
  if (opts.transcript && hasAudio && opts.transcriber === "whisper") done(opts.model);
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "v2c-"));

  try {
    // 2. Source copies (preserve lineage of originals inside the package).
    if (opts.copySource) {
      step("Copying source media");
      for (const s of sources) {
        await fs.copyFile(s.path, path.join(dirs.source, s.name));
      }
      done(`${sources.length} file(s) → source/`);
    } else {
      await fs.rmdir(dirs.source).catch(() => {});
    }

    // 3. Audio — extract each source to wav, then concatenate.
    const audioPath = path.join(dirs.audio, "audio.wav");
    if (hasAudio) {
      step("Extracting audio (mono 16 kHz WAV)");
      await extractAudio(ffmpeg, sources, audioPath, tmp, {
        onProgress: opts.voiceMemos
          ? ({ index, total, source }) =>
              info(`extracting ${index + 1}/${total}: ${source.name}`)
          : null,
      });
      done(path.relative(outDir, audioPath));
      if (audioSources.length < sources.length) {
        warn(
          `${sources.length - audioSources.length} source(s) had no audio; inserted silence to preserve timeline alignment.`,
        );
      }
    } else {
      await fs.rmdir(dirs.audio).catch(() => {});
      warn(noAudioWarning);
    }

    // 4. Frames — extract per video source, then merge onto the combined timeline.
    let frames = [];
    if (opts.frames && hasVideo) {
      const label =
        opts.scene != null
          ? `scene change > ${opts.scene}`
          : `every ${opts.interval}s`;
      step(`Extracting screenshots (${label})`);
      frames = await extractFrames(ffmpeg, sources, dirs.frames, tmp, opts);
      done(`${frames.length} screenshots`);
    } else {
      await fs.rmdir(dirs.frames).catch(() => {});
      if (opts.frames && !hasVideo) {
        info("No video stream found; skipping screenshots and contact sheet.");
      }
    }

    // 5. Transcription on the combined audio.
    let segments = [];
    if (opts.transcript && hasAudio) {
      step(transcriptionStepLabel(opts));
      info("this can take a while on longer recordings...");
      const prefix = path.join(dirs.transcript, "transcript");
      if (opts.transcriber === "whisper") {
        await transcribeWithWhisper(transcriber, {
          audioPath,
          prefix,
          modelPath,
          language: opts.language,
        });
      } else {
        await transcribeWithParakeet(transcriber, {
          audioPath,
          transcriptDir: dirs.transcript,
          tmp,
          opts,
        });
      }
      segments = await parseTranscript(`${prefix}.json`);
      const exts = opts.transcriber === "parakeet" ? "txt,srt,vtt,json" : "txt,srt,json";
      done(`${segments.length} segments → transcript/transcript.{${exts}}`);
    } else {
      await fs.rmdir(dirs.transcript).catch(() => {});
    }

    // 6. Contact sheet.
    let contactSheetFile = null;
    if (opts.frames && opts.contact > 0 && frames.length) {
      step(
        `Building contact sheet (${Math.min(opts.contact, frames.length)} frames)`,
      );
      const out = path.join(outDir, "contact_sheet.jpg");
      await buildContactSheet(ffmpeg, frames, dirs.frames, out, {
        count: opts.contact,
        multiSource: sources.length > 1,
      });
      contactSheetFile = "contact_sheet.jpg";
      done("contact_sheet.jpg");
    }

    // 7. Reports.
    step("Writing index.md + report.html");
    const generated = new Date(parseInt(process.env.V2C_NOW || Date.now(), 10))
      .toISOString()
      .replace("T", " ")
      .slice(0, 16);
    await writeIndex({
      outDir,
      title,
      sources,
      totalDuration,
      frames,
      opts,
      hasContactSheet: !!contactSheetFile,
      transcriptUnavailable,
    });
    await writeHtmlReport({
      outDir,
      title,
      sources,
      totalDuration,
      frames,
      segments,
      opts,
      contactSheetFile,
      generated,
      transcriptUnavailable,
    });
    done("index.md, report.html");

    // 8. Idempotency manifest + agent-friendly output list.
    runManifest.outputs = {
      contactSheetFile,
      generated,
    };
    await fs.writeFile(
      manifestPath,
      `${JSON.stringify(runManifest, null, 2)}\n`,
      "utf8",
    );
    await printManifest({
      outDir,
      dirs,
      sources,
      frames,
      opts,
      contactSheetFile,
      audioPath,
      hasAudio,
    });
    await openReportIfRequested(opts.openReport, outDir);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

async function applyVoiceMemosPreset(opts) {
  if (!opts.voiceMemos) {
    opts.input = expandHome(opts.input);
    opts.output = expandHome(opts.output);
    return;
  }

  step("Locating Apple Voice Memos");
  if (!opts.input) opts.input = await findVoiceMemosDir();
  else opts.input = expandHome(opts.input);
  if (!opts.output) opts.output = path.join(os.homedir(), ".v2c-voice-memos");
  else opts.output = expandHome(opts.output);

  opts.copySource = false;
  opts.frames = false;
  opts.contact = 0;
  opts.recursive = true;
  if (!opts.noOpen) opts.openReport = true;
  done(opts.input);
}

async function findVoiceMemosDir() {
  const home = os.homedir();
  const candidates = [
    path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Voice Memos"),
    path.join(home, "Library/Mobile Documents/com~apple~CloudDocs/Documents/Voice Memos"),
    path.join(home, "Library/Mobile Documents/iCloud~com~apple~VoiceMemos"),
    path.join(home, "Library/Mobile Documents/iCloud~com~apple~VoiceMemos/Documents"),
    path.join(
      home,
      "Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings",
    ),
    path.join(home, "Library/Group Containers/group.com.apple.VoiceMemos.shared"),
    path.join(home, "Library/Containers/com.apple.VoiceMemos/Data/Documents"),
    path.join(home, "Library/Containers/com.apple.VoiceMemos/Data/Library/Application Support"),
    path.join(home, "Library/Application Support/com.apple.voicememos/Recordings"),
  ];
  const inaccessible = [];

  for (const candidate of candidates) {
    info(`checking ${candidate}`);
    const result = await inspectVoiceMemoCandidate(candidate);
    if (result.ok) return candidate;
    if (result.exists && result.error) {
      inaccessible.push(`${candidate}: ${result.error}`);
    }
  }

  const namedCloudDirs = await findNamedVoiceMemoDirs(
    path.join(home, "Library/Mobile Documents"),
  );
  for (const candidate of namedCloudDirs) {
    info(`checking ${candidate}`);
    const result = await inspectVoiceMemoCandidate(candidate);
    if (result.ok) return candidate;
    if (result.exists && result.error) {
      inaccessible.push(`${candidate}: ${result.error}`);
    }
  }

  info("checking Spotlight metadata");
  const spotlight = await findVoiceMemosDirWithSpotlight();
  if (spotlight) return spotlight;

  const hint = inaccessible.length
    ? "\n\nSome likely Voice Memos locations exist but could not be read:\n" +
      inaccessible.map((p) => `  - ${p}`).join("\n") +
      "\n\nGrant Full Disk Access to your terminal app, then rerun `v2c --voice-memos`."
    : "";
  throw new Error(
    "Could not auto-detect an Apple Voice Memos folder.\n" +
      "Pass it explicitly, e.g.:\n" +
      "    video-to-context --voice-memos /path/to/Voice\\ Memos" +
      hint,
  );
}

async function findNamedVoiceMemoDirs(root) {
  const found = [];
  await walkDirs(root, {
    maxDepth: 5,
    onDir: (dir) => {
      const base = path.basename(dir).toLowerCase();
      if (
        base.includes("voice memos") ||
        base.includes("voicememos") ||
        base.includes("voice-memos")
      ) {
        found.push(dir);
      }
    },
  }).catch(() => {});
  return found;
}

async function walkDirs(dir, { maxDepth, onDir }, depth = 0, state = { dirs: 0 }) {
  if (depth > maxDepth) return;
  state.dirs++;
  if (state.dirs === 1 || state.dirs % 50 === 0) {
    info(`searched ${state.dirs} iCloud folder(s); now ${dir}`);
  }
  onDir(dir);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await walkDirs(path.join(dir, entry.name), { maxDepth, onDir }, depth + 1, state)
      .catch(() => {});
  }
}

async function findVoiceMemosDirWithSpotlight() {
  if (process.platform !== "darwin") return null;
  try {
    const { stdout } = await exec(
      "mdfind",
      ["kMDItemContentTypeTree == 'public.audio'"],
      { capture: true },
    );
    const paths = stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean)
      .filter((p) => {
        const lower = p.toLowerCase();
        return (
          lower.includes("voice memo") ||
          lower.includes("voicememos") ||
          lower.includes("voice-memos")
        );
      });
    const dirs = countBy(paths.map((p) => path.dirname(p)));
    for (const dir of [...dirs.keys()].sort((a, b) => dirs.get(b) - dirs.get(a))) {
      const result = await inspectVoiceMemoCandidate(dir);
      if (result.ok) return dir;
    }
  } catch {
    return null;
  }
  return null;
}

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
  return counts;
}

async function inspectVoiceMemoCandidate(dir) {
  try {
    await fs.stat(dir);
  } catch {
    return { ok: false, exists: false, error: null };
  }

  try {
    await resolveInputs(dir, { recursive: true });
    return { ok: true, exists: true, error: null };
  } catch (err) {
    return { ok: false, exists: true, error: err.message };
  }
}

function expandHome(value) {
  if (!value || typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function uniquePackageDir(root, file) {
  const stem = path.basename(file, path.extname(file));
  const safe = stem
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "voice-memo";
  return path.join(root, `${safe}-context`);
}

function describeNextAction(packageDir, status) {
  switch (status.nextAction) {
    case "run_llm":
      return `v2c analyze ${packageDir} --run-llm --derive`;
    case "run_codex":
      return `v2c analyze ${packageDir} --prepare-codex --run-codex --derive`;
    case "import_codex":
      return `v2c analyze ${packageDir} --import-codex --derive`;
    case "derive":
      return `v2c analyze ${packageDir} --derive`;
    case "prepare_codex":
      return `v2c analyze ${packageDir} --prepare-codex`;
    case "segment":
      return `v2c analyze ${packageDir}`;
    case "transcribe":
      return `v2c voice-memos`;
    default:
      return "none";
  }
}

async function pathExists(file) {
  return fs.stat(file).then(() => true, () => false);
}

async function openReportIfRequested(openReport, outDir) {
  if (!openReport) return;
  const reportPath = path.join(outDir, "report.html");
  if (process.platform !== "darwin") {
    warn(`Report is ready: ${reportPath}`);
    return;
  }
  try {
    await exec("open", [reportPath], { quiet: true });
  } catch (err) {
    warn(`Could not open report.html automatically: ${err.message}`);
  }
}

async function buildRunManifest({ mode, dir, media, sources, totalDuration, opts }) {
  const files = [];
  for (const p of media) {
    const st = await fs.stat(p);
    files.push({
      path: path.resolve(p),
      name: path.basename(p),
      size: st.size,
      mtimeMs: Math.trunc(st.mtimeMs),
    });
  }

  return {
    schemaVersion: 1,
    input: {
      mode,
      dir: path.resolve(dir),
      files,
    },
    options: {
      model: opts.model,
      transcriber: opts.transcriber,
      language: opts.language,
      decoding: opts.decoding,
      beamSize: opts.beamSize,
      interval: opts.interval,
      scene: opts.scene,
      contact: opts.contact,
      copySource: opts.copySource,
      frames: opts.frames,
      transcript: opts.transcript,
      recursive: opts.recursive,
    },
    sources: sources.map((s) => ({
      index: s.index,
      path: path.resolve(s.path),
      name: s.name,
      duration: s.duration,
      hasAudio: s.hasAudio,
      hasVideo: s.hasVideo,
      offset: s.offset,
    })),
    totalDuration,
  };
}

async function findTranscriber(name) {
  if (name === "whisper") {
    const found = await findWhisper();
    return { ...found, name, label: "whisper.cpp" };
  }
  const found = await findParakeet();
  return { ...found, name, label: "parakeet-mlx" };
}

function transcriptionStepLabel(opts) {
  if (opts.transcriber === "whisper") {
    return `Transcribing with whisper.cpp (model: ${opts.model})`;
  }
  const decoding = opts.decoding ? `, decoding: ${opts.decoding}` : "";
  return `Transcribing with parakeet-mlx${decoding}`;
}

async function transcribeWithWhisper(whisper, { audioPath, prefix, modelPath, language }) {
  const wargs = [
    "-m",
    modelPath,
    "-f",
    audioPath,
    "-otxt",
    "-osrt",
    "-oj",
    "-of",
    prefix,
  ];
  if (language) wargs.push("-l", language);
  await exec(whisper.bin, wargs, { quiet: false });
}

async function transcribeWithParakeet(parakeet, { audioPath, transcriptDir, tmp, opts }) {
  const parakeetOut = path.join(tmp, "parakeet-transcript");
  await fs.mkdir(parakeetOut, { recursive: true });
  const args = [
    audioPath,
    "--output-format",
    "all",
    "--output-dir",
    parakeetOut,
    "--chunk-duration",
    "120",
    "--overlap-duration",
    "15",
    "--verbose",
  ];
  if (opts.decoding) args.push("--decoding", opts.decoding);
  if (opts.beamSize != null) args.push("--beam-size", String(opts.beamSize));
  await exec(parakeet.bin, args, { quiet: false });

  for (const ext of ["txt", "json", "srt", "vtt"]) {
    const produced = await findTranscriptArtifact(parakeetOut, ext);
    if (produced) {
      await fs.copyFile(produced, path.join(transcriptDir, `transcript.${ext}`));
    }
  }
}

async function findTranscriptArtifact(dir, ext) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const matches = [];
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findTranscriptArtifact(file, ext);
      if (nested) matches.push(nested);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(`.${ext}`)) {
      matches.push(file);
    }
  }
  matches.sort((a, b) => path.basename(a).localeCompare(path.basename(b)));
  return matches[0] || null;
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function sameManifest(a, b) {
  const comparable = (value) => {
    const { outputs, ...rest } = value || {};
    return rest;
  };
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}

async function extractAudio(ffmpeg, sources, audioPath, tmp, { onProgress = null } = {}) {
  const wavs = [];
  for (const s of sources) {
    if (onProgress) onProgress({ index: s.index, total: sources.length, source: s });
    const w = path.join(tmp, `audio_${s.index}.wav`);
    if (s.hasAudio) {
      await exec(ffmpeg, [
        "-y",
        "-i",
        s.path,
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        w,
      ]);
    } else {
      await exec(ffmpeg, [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=channel_layout=mono:sample_rate=16000",
        "-t",
        String(s.duration || 0),
        "-acodec",
        "pcm_s16le",
        w,
      ]);
    }
    wavs.push(w);
  }
  if (wavs.length === 1) {
    await fs.copyFile(wavs[0], audioPath);
    return;
  }
  const listFile = path.join(tmp, "audio_list.txt");
  await fs.writeFile(
    listFile,
    wavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'`).join("\n"),
    "utf8",
  );
  await exec(ffmpeg, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    audioPath,
  ]);
}

async function extractFrames(ffmpeg, sources, framesDir, tmp, opts) {
  const merged = [];
  let n = 0;
  for (const s of sources) {
    if (!s.hasVideo) continue;
    const srcTmp = path.join(tmp, `frames_${s.index}`);
    await fs.mkdir(srcTmp, { recursive: true });
    const local =
      opts.scene != null
        ? await extractScene(ffmpeg, s.path, srcTmp, opts.scene)
        : await extractInterval(ffmpeg, s.path, srcTmp, opts.interval);
    for (const f of local) {
      n++;
      const file = `frame_${String(n).padStart(4, "0")}.jpg`;
      await fs.rename(path.join(srcTmp, f.file), path.join(framesDir, file));
      merged.push({
        file,
        sourceIndex: s.index,
        localTime: f.time,
        globalTime: s.offset + (f.time ?? 0),
      });
    }
  }
  return merged;
}

async function extractInterval(ffmpeg, input, framesDir, interval) {
  await exec(ffmpeg, [
    "-y",
    "-i",
    input,
    "-vf",
    `fps=1/${interval}`,
    "-q:v",
    "2",
    path.join(framesDir, "frame_%04d.jpg"),
  ]);
  const files = (await fs.readdir(framesDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort();
  return files.map((file, idx) => ({ file, time: idx * interval }));
}

async function extractScene(ffmpeg, input, framesDir, threshold) {
  const { stderr } = await exec(ffmpeg, [
    "-y",
    "-i",
    input,
    "-vf",
    `select='gt(scene,${threshold})',showinfo`,
    "-vsync",
    "vfr",
    "-q:v",
    "2",
    path.join(framesDir, "scene_%04d.jpg"),
  ]);
  const times = [...stderr.matchAll(/pts_time:([0-9.]+)/g)].map((m) =>
    parseFloat(m[1]),
  );
  const files = (await fs.readdir(framesDir))
    .filter((f) => f.endsWith(".jpg"))
    .sort();
  return files.map((file, idx) => ({ file, time: times[idx] ?? null }));
}

async function printManifest({
  outDir,
  dirs,
  sources,
  frames,
  opts,
  contactSheetFile,
  audioPath,
  hasAudio,
}) {
  const produced = [["index", path.join(outDir, "index.md")]];
  produced.push(["report", path.join(outDir, "report.html")]);
  if (contactSheetFile)
    produced.push(["contact_sheet", path.join(outDir, contactSheetFile)]);
  if (opts.transcript && hasAudio) {
    for (const ext of ["txt", "srt", "json", "vtt"]) {
      produced.push([
        `transcript_${ext}`,
        path.join(dirs.transcript, `transcript.${ext}`),
      ]);
    }
  }
  if (hasAudio) produced.push(["audio", audioPath]);
  if (opts.frames) {
    const frameFiles = frames.length
      ? frames.map((f) => f.file)
      : await listExistingFrames(dirs.frames);
    for (const file of frameFiles)
      produced.push(["frame", path.join(dirs.frames, file)]);
  }
  if (opts.copySource) {
    for (const s of sources)
      produced.push(["source", path.join(dirs.source, s.name)]);
  }

  const existing = [];
  for (const [kind, p] of produced) {
    if (
      await fs
        .stat(p)
        .then(() => true)
        .catch(() => false)
    )
      existing.push([kind, p]);
  }

  log(`\n\x1b[32m✓ Done.\x1b[0m  Context package ready at:\n  ${outDir}\n`);
  log(`\x1b[1mOutput files:\x1b[0m`);
  for (const [kind, p] of existing) log(`  ${kind.padEnd(15)} ${p}`);
  log("");
}

async function listExistingFrames(framesDir) {
  try {
    return (await fs.readdir(framesDir))
      .filter((f) => f.toLowerCase().endsWith(".jpg"))
      .sort();
  } catch {
    return [];
  }
}
