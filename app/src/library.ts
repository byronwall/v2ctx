import type { VoiceMemoLibrary } from "./types";
import type { LibraryLoadResult } from "./reviewTypes";

export async function fetchVoiceMemoLibrary(): Promise<LibraryLoadResult> {
  try {
    const response = await fetch("/api/voice-memos", { cache: "no-store" });
    if (!response.ok) throw new Error(`Voice memo scan failed: ${response.status}`);
    const library = (await response.json()) as VoiceMemoLibrary;
    if (library.packages.length === 0) throw new Error(`No context packages found in ${library.root}`);
    return { library };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Could not load voice memo packages.",
    };
  }
}
