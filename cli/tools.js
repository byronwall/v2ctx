import { confirm, exec, info, warn } from "./util.js";

async function which(name) {
  try {
    const { stdout } = await exec("which", [name], { capture: true });
    const p = stdout.trim();
    return p || null;
  } catch {
    return null;
  }
}

const DEPENDENCIES = {
  ffmpeg: {
    label: "FFmpeg",
    brew: "ffmpeg",
    binaries: ["ffmpeg", "ffprobe"],
    hint: "brew install ffmpeg",
  },
  uv: {
    label: "uv",
    brew: "uv",
    binaries: ["uv"],
    hint: "brew install uv",
  },
  parakeet: {
    label: "parakeet-mlx",
    binaries: ["parakeet-mlx"],
    hint: "uv tool install parakeet-mlx -U",
    install: async () => {
      const uv = await which("uv");
      if (!uv) throw new Error("uv not found");
      await exec(uv, ["tool", "install", "parakeet-mlx", "-U"], { quiet: false });
    },
  },
  whisper: {
    label: "whisper.cpp",
    brew: "whisper-cpp",
    binaries: ["whisper-cli", "whisper-cpp", "whisper"],
    hint: "brew install whisper-cpp",
  },
};

async function inspectDependency(dep) {
  const found = {};
  for (const bin of dep.binaries) {
    found[bin] = await which(bin);
  }
  return found;
}

async function missingDependencies({ transcript, transcriber }) {
  const missing = [];
  const ffmpeg = await inspectDependency(DEPENDENCIES.ffmpeg);
  if (!ffmpeg.ffmpeg || !ffmpeg.ffprobe) missing.push(DEPENDENCIES.ffmpeg);

  if (transcript && transcriber === "whisper") {
    const whisper = await inspectDependency(DEPENDENCIES.whisper);
    if (!DEPENDENCIES.whisper.binaries.some((bin) => whisper[bin])) {
      missing.push(DEPENDENCIES.whisper);
    }
  }
  if (transcript && transcriber === "parakeet") {
    const uv = await inspectDependency(DEPENDENCIES.uv);
    if (!uv.uv) missing.push(DEPENDENCIES.uv);
    const parakeet = await inspectDependency(DEPENDENCIES.parakeet);
    if (!parakeet["parakeet-mlx"]) missing.push(DEPENDENCIES.parakeet);
  }

  return missing;
}

export async function ensureLocalTools({ transcript, transcriber = "parakeet", yes = false } = {}) {
  let missing = await missingDependencies({ transcript, transcriber });
  if (!missing.length) return;

  warn(
    `Missing local dependenc${missing.length === 1 ? "y" : "ies"}: ${missing
      .map((dep) => dep.label)
      .join(", ")}`,
  );
  for (const dep of missing) info(`install with: ${dep.hint}`);

  const brewDeps = missing.filter((dep) => dep.brew);
  const toolDeps = missing.filter((dep) => dep.install);
  const installArgs = ["install", ...brewDeps.map((dep) => dep.brew)];
  if (!yes) {
    const approved = await confirm(
      `Install ${missing.map((dep) => dep.label).join(" and ")} now?`,
    );
    if (approved !== true) {
      const promptHint = approved === null ? "Non-interactive shell detected. " : "";
      const commands = [];
      if (brewDeps.length) commands.push(`brew ${installArgs.join(" ")}`);
      for (const dep of toolDeps) commands.push(dep.hint);
      throw new Error(
        `${promptHint}Install the missing dependencies, or rerun with -y to allow:\n    ${commands.join("\n    ")}`,
      );
    }
  }

  if (brewDeps.length) {
    const brew = await which("brew");
    if (!brew) {
      throw new Error(
        "Homebrew was not found, so dependencies could not be installed automatically.\n" +
          `Install Homebrew, then run:\n    brew ${installArgs.join(" ")}`,
      );
    }

    warn(`Installing dependencies: brew ${installArgs.join(" ")}`);
    await exec(brew, installArgs, { quiet: false });
  }

  for (const dep of toolDeps) {
    warn(`Installing dependency: ${dep.hint}`);
    await dep.install();
  }

  missing = await missingDependencies({ transcript, transcriber });
  if (missing.length) {
    throw new Error(
      `Dependency installation finished, but still missing: ${missing
        .map((dep) => dep.label)
        .join(", ")}`,
    );
  }
}

/** Locate ffmpeg/ffprobe; throw with install hint if missing. */
export async function findFfmpeg() {
  const ffmpeg = await which("ffmpeg");
  if (!ffmpeg) {
    throw new Error(
      "ffmpeg not found. Install it with:\n    brew install ffmpeg"
    );
  }
  const ffprobe = await which("ffprobe");
  if (!ffprobe) {
    throw new Error(
      "ffprobe not found. Install it with:\n    brew install ffmpeg"
    );
  }
  return { ffmpeg, ffprobe };
}

/**
 * Locate the whisper.cpp CLI. The Homebrew formula installs `whisper-cli`
 * (older versions shipped `whisper-cpp` / `main`). Return the first match.
 */
export async function findWhisper() {
  for (const name of ["whisper-cli", "whisper-cpp", "whisper"]) {
    const p = await which(name);
    if (p) return { bin: name, path: p };
  }
  throw new Error(
    "whisper.cpp not found. Install it with:\n    brew install whisper-cpp\n" +
      "(provides the `whisper-cli` binary)"
  );
}

/** Locate the parakeet-mlx CLI installed by `uv tool install parakeet-mlx -U`. */
export async function findParakeet() {
  const p = await which("parakeet-mlx");
  if (p) return { bin: "parakeet-mlx", path: p };
  throw new Error(
    "parakeet-mlx not found. Install it with:\n" +
      "    brew install uv\n" +
      "    uv tool install parakeet-mlx -U"
  );
}
