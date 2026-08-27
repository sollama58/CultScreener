import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** The three alert sounds offered in Settings. Synthesised, not sampled - see utils/alertSound.ts. */
export type AlertSoundName = "cork" | "ring" | "bell";

export interface Preferences {
  /** Show the detected theme chips (AI, MEME, DOG...) on each card. Off by default: they are a
   *  guess made from the token's name, so they are opt-in rather than presented as fact. */
  showThemeLabels: boolean;
  /** Play a sound when a new alert lands on the feed. Off by default - a page that makes noise
   *  without being asked to is a page people close. */
  alertSoundEnabled: boolean;
  alertSound: AlertSoundName;
  /** 0-1. Applied as the master gain, so 0 is genuinely silent. */
  alertVolume: number;
}

export const DEFAULT_PREFERENCES: Preferences = {
  showThemeLabels: false,
  alertSoundEnabled: false,
  alertSound: "cork",
  alertVolume: 0.5,
};

const STORAGE_KEY = "trenches.preferences";
const SOUND_NAMES: AlertSoundName[] = ["cork", "ring", "bell"];

/**
 * Read stored preferences, field by field.
 *
 * Deliberately not `{...DEFAULTS, ...JSON.parse(raw)}`: that trusts whatever is in storage, and
 * this value survives deploys. A stored `alertVolume: "loud"` from some future version would then
 * reach the gain node and throw on every alert. Each field is validated on its own so one bad
 * entry costs its own default and nothing else.
 */
function readStored(): Preferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  let raw: string | null = null;
  try {
    // Throws outright in some privacy modes, rather than returning null.
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (!raw) return DEFAULT_PREFERENCES;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  if (typeof parsed !== "object" || parsed === null) return DEFAULT_PREFERENCES;
  const source = parsed as Record<string, unknown>;

  return {
    showThemeLabels:
      typeof source.showThemeLabels === "boolean"
        ? source.showThemeLabels
        : DEFAULT_PREFERENCES.showThemeLabels,
    alertSoundEnabled:
      typeof source.alertSoundEnabled === "boolean"
        ? source.alertSoundEnabled
        : DEFAULT_PREFERENCES.alertSoundEnabled,
    alertSound: SOUND_NAMES.includes(source.alertSound as AlertSoundName)
      ? (source.alertSound as AlertSoundName)
      : DEFAULT_PREFERENCES.alertSound,
    alertVolume:
      typeof source.alertVolume === "number" && Number.isFinite(source.alertVolume)
        ? Math.min(1, Math.max(0, source.alertVolume))
        : DEFAULT_PREFERENCES.alertVolume,
  };
}

interface PreferencesValue {
  prefs: Preferences;
  /** Merges a partial update and persists the result. */
  update: (patch: Partial<Preferences>) => void;
}

const PreferencesContext = createContext<PreferencesValue>({
  prefs: DEFAULT_PREFERENCES,
  update: () => {},
});

/**
 * Per-device display and sound settings, kept in localStorage rather than on the account.
 *
 * These are properties of the machine you're sitting at, not of you: a volume that suits
 * headphones on a laptop is wrong on a desk speaker, and someone who wants the chime at work
 * doesn't necessarily want it on their phone. Storing them server-side would sync exactly the
 * wrong thing. Everything account-shaped on this page (Telegram linking, alert mode) still lives
 * on the server.
 */
export function PreferencesProvider({ children }: { children: ReactNode }) {
  const [prefs, setPrefs] = useState<Preferences>(readStored);

  // Kept in step across tabs: changing the volume in one tab shouldn't leave another tab chiming
  // at the old level until it happens to be reloaded.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== STORAGE_KEY) return;
      setPrefs(readStored());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const update = useCallback((patch: Partial<Preferences>) => {
    setPrefs((current) => {
      const next = { ...current, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage full, or blocked entirely. The setting still applies for this session; losing
        // it on reload is a far better outcome than the toggle appearing not to work at all.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ prefs, update }), [prefs, update]);
  return <PreferencesContext.Provider value={value}>{children}</PreferencesContext.Provider>;
}

export function usePreferences(): PreferencesValue {
  return useContext(PreferencesContext);
}
