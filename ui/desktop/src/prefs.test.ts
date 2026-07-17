import { describe, it, expect } from "vitest";
import { DEFAULT_VOICE_PREFS, loadVoicePrefs, saveVoicePrefs, type VoicePrefs } from "./prefs";

function memoryStorage(initial?: Record<string, string>) {
  const store = new Map(Object.entries(initial ?? {}));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

describe("voice prefs", () => {
  it("returns defaults when nothing is stored", () => {
    expect(loadVoicePrefs(memoryStorage())).toEqual(DEFAULT_VOICE_PREFS);
  });

  it("round-trips a saved preference", () => {
    const storage = memoryStorage();
    const prefs: VoicePrefs = { mode: "push_to_talk", threshold_dbfs: -32, hangover_ms: 500 };
    saveVoicePrefs(prefs, storage);
    expect(loadVoicePrefs(storage)).toEqual(prefs);
  });

  it("rejects unknown modes and clamps numbers", () => {
    const storage = memoryStorage({
      "ourcord.voice_prefs": JSON.stringify({ mode: "yelling", threshold_dbfs: -999, hangover_ms: 1e9 }),
    });
    expect(loadVoicePrefs(storage)).toEqual({ mode: "voice_activity", threshold_dbfs: -60, hangover_ms: 2000 });
  });

  it("survives corrupted JSON", () => {
    const storage = memoryStorage({ "ourcord.voice_prefs": "{not json" });
    expect(loadVoicePrefs(storage)).toEqual(DEFAULT_VOICE_PREFS);
  });

  it("survives a throwing storage", () => {
    const storage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(loadVoicePrefs(storage)).toEqual(DEFAULT_VOICE_PREFS);
    expect(() => saveVoicePrefs(DEFAULT_VOICE_PREFS, storage)).not.toThrow();
  });
});
