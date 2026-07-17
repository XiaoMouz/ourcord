// Voice input preferences persist in localStorage because the daemon only
// reports the active input_mode, not the configured threshold/hangover —
// without this the UI would reset PTT users to voice-activity on every join.
export type VoiceMode = "voice_activity" | "push_to_talk" | "open_mic";
export type VoicePrefs = { mode: VoiceMode; threshold_dbfs: number; hangover_ms: number };

export const DEFAULT_VOICE_PREFS: VoicePrefs = { mode: "voice_activity", threshold_dbfs: -45, hangover_ms: 300 };

const STORAGE_KEY = "ourcord.voice_prefs";
const MODES: ReadonlySet<string> = new Set(["voice_activity", "push_to_talk", "open_mic"]);

type PrefStorage = Pick<Storage, "getItem" | "setItem">;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

export function loadVoicePrefs(storage: PrefStorage = localStorage): VoicePrefs {
  let raw: string | null = null;
  try { raw = storage.getItem(STORAGE_KEY); } catch { return { ...DEFAULT_VOICE_PREFS }; }
  if (!raw) return { ...DEFAULT_VOICE_PREFS };
  try {
    const parsed = JSON.parse(raw) as Partial<VoicePrefs>;
    return {
      mode: typeof parsed.mode === "string" && MODES.has(parsed.mode) ? (parsed.mode as VoiceMode) : DEFAULT_VOICE_PREFS.mode,
      threshold_dbfs: clamp(parsed.threshold_dbfs, -60, -20, DEFAULT_VOICE_PREFS.threshold_dbfs),
      hangover_ms: clamp(parsed.hangover_ms, 0, 2000, DEFAULT_VOICE_PREFS.hangover_ms),
    };
  } catch {
    return { ...DEFAULT_VOICE_PREFS };
  }
}

export function saveVoicePrefs(prefs: VoicePrefs, storage: PrefStorage = localStorage): void {
  try { storage.setItem(STORAGE_KEY, JSON.stringify(prefs)); } catch { /* private mode etc. */ }
}
