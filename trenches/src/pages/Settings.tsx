import { useEffect, useState } from "react";
import { getTelegramStatus, linkTelegram, setAlertMode, unlinkTelegram } from "../api/client";
import type { AlertMode, TelegramStatus } from "../api/types";
import { usePreferences, type AlertSoundName,
  SCROLL_STALE_MIN_MINUTES,
  SCROLL_STALE_MAX_MINUTES,
} from "../context/PreferencesContext";
import { playAlertSound, unlockAudio } from "../utils/alertSound";
import { useSubscription } from "../context/SubscriptionContext";

const ALERT_MODE_LABELS: Record<AlertMode, string> = {
  REALTIME: "Real-time only",
  DIGEST: "Daily digest only",
  BOTH: "Real-time + daily digest",
  OFF: "Off",
};

export function Settings() {
  return (
    <div className="settings-page">
      <h2>Settings</h2>
      <AccessCard />
      <TelegramCard />
      <LiveFeedCard />
      <ScrollCard />
      <DisplayCard />
      <SoundCard />
    </div>
  );
}

/** How long this wallet's access runs, and where it came from. */
function AccessCard() {
  const { status, loading } = useSubscription();

  if (loading) return <p className="empty-state">Loading access…</p>;
  if (!status) return null;

  const expiresAt = status.expiresAt ? new Date(status.expiresAt) : null;
  const daysLeft =
    expiresAt !== null ? Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 86_400_000)) : null;

  const describe = () => {
    switch (status.reason) {
      case "admin":
        return "You're an admin - access doesn't expire.";
      case "whitelist":
        return expiresAt
          ? `Free access, until ${expiresAt.toLocaleDateString()}.`
          : "Free access, with no expiry.";
      case "subscription":
        return `Paid access${expiresAt ? `, ${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : ""}.`;
      default:
        return expiresAt
          ? `Expired on ${expiresAt.toLocaleDateString()}.`
          : "No access yet - burn to unlock the feed.";
    }
  };

  return (
    <div className="settings-card">
      <h3>Access</h3>
      <p className={`settings-card__status${status.hasAccess ? " settings-card__status--linked" : ""}`}>
        {status.hasAccess ? "✅ " : ""}
        {describe()}
      </p>
      {expiresAt && status.reason === "subscription" && (
        <p className="settings-toggle__hint">
          Renews for {status.price.tokensPerMonth.toLocaleString()} $ASDFASDFA per{" "}
          {status.price.daysPerMonth} days. Burning before this runs out adds to the time you have left
          rather than replacing it.
        </p>
      )}
      {status.burnCount > 0 && (
        <p className="settings-toggle__hint">
          {status.burnCount} burn{status.burnCount === 1 ? "" : "s"} on record for this wallet.
        </p>
      )}
    </div>
  );
}

/**
 * Telegram linking and alert mode - account settings, stored server-side.
 *
 * Its own component so that its loading state is its own: the device preferences below are read
 * from localStorage and have no reason to wait on, or disappear with, a failed /telegram call.
 */
function TelegramCard() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [linkInfo, setLinkInfo] = useState<{ linkCode: string; deepLink: string | null } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => getTelegramStatus().then(setStatus);

  useEffect(() => {
    void refresh();
  }, []);

  const handleLink = async () => {
    setBusy(true);
    try {
      const result = await linkTelegram();
      setLinkInfo(result);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleUnlink = async () => {
    if (!confirm("Unlink Telegram? You'll stop getting alerts there.")) return;
    setBusy(true);
    try {
      await unlinkTelegram();
      setLinkInfo(null);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const handleAlertModeChange = async (mode: AlertMode) => {
    setBusy(true);
    try {
      await setAlertMode(mode);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p className="empty-state">Loading Telegram settings…</p>;

  // linkInfo only exists right after clicking "Link Telegram" this session; status.pendingLinkCode
  // survives a reload. Reconstruct the same deep link from status when linkInfo is gone so the
  // "Open Telegram" button doesn't disappear just because the page was refreshed mid-flow.
  const pendingCode = linkInfo?.linkCode ?? status.pendingLinkCode;
  const deepLink =
    linkInfo?.deepLink ??
    (status.botUsername && pendingCode ? `https://t.me/${status.botUsername}?start=${pendingCode}` : null);

  return (
    <div className="settings-card">
      <h3>Telegram alerts</h3>

      {!status.enabled ? (
        <p className="settings-card__status">
          Telegram alerts aren't set up on this deployment yet - check back later. The dashboard will keep
          showing your matches here in the meantime.
        </p>
      ) : status.linked ? (
        <>
          <p className="settings-card__status settings-card__status--linked">✅ Telegram linked</p>
          <label className="settings-card__select">
            Alert mode
            <select
              value={status.alertMode}
              onChange={(e) => void handleAlertModeChange(e.target.value as AlertMode)}
              disabled={busy}
            >
              {(Object.keys(ALERT_MODE_LABELS) as AlertMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {ALERT_MODE_LABELS[mode]}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn--danger" onClick={() => void handleUnlink()} disabled={busy}>
            Unlink Telegram
          </button>
        </>
      ) : (
        <>
          <p className="settings-card__status">Not linked yet.</p>
          {pendingCode ? (
            <div className="settings-card__pending">
              <p>
                Send <code>/start {pendingCode}</code> to the bot on Telegram to finish linking.
              </p>
              {deepLink && (
                <a className="btn btn--primary" href={deepLink} target="_blank" rel="noreferrer">
                  Open Telegram
                </a>
              )}
              <button className="btn" onClick={() => void handleLink()} disabled={busy}>
                Generate new code
              </button>
            </div>
          ) : (
            <button className="btn btn--primary" onClick={() => void handleLink()} disabled={busy}>
              Link Telegram
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** What the Live Feed is allowed to show. Device-local - see PreferencesContext. */
function LiveFeedCard() {
  const { prefs, update } = usePreferences();

  return (
    <div className="settings-card">
      <h3>Live Feed</h3>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.includeCuratedInFeed}
          onChange={(e) => update({ includeCuratedInFeed: e.target.checked })}
        />
        <span className="settings-toggle__text">
          <span className="settings-toggle__title">Include Curated Alerts</span>
          <span className="settings-toggle__hint">
            Mixes the curator&apos;s picks into the Live Feed alongside the tokens your own filters
            caught, tinted and marked ★ Curated. Off by default, so the Live Feed answers one question -
            what did my filters find? Either way they keep their own tab.
          </span>
        </span>
      </label>
    </div>
  );
}

/**
 * The Scroll tab's staleness window. Its own card rather than a line in Display, because it
 * changes what the deck CONTAINS rather than how it looks - a two-minute window and a
 * thirty-minute one are different products.
 */
function ScrollCard() {
  const { prefs, update } = usePreferences();

  return (
    <div className="settings-card">
      <h3>Scroll</h3>

      <label className="settings-slider">
        <span className="settings-slider__row">
          <span className="settings-toggle__title">Show alerts from the last</span>
          <span className="settings-slider__value">{prefs.scrollStaleMinutes} min</span>
        </span>
        <input
          type="range"
          min={SCROLL_STALE_MIN_MINUTES}
          max={SCROLL_STALE_MAX_MINUTES}
          step={1}
          value={prefs.scrollStaleMinutes}
          onChange={(e) => update({ scrollStaleMinutes: Number(e.target.value) })}
        />
        <span className="settings-toggle__hint">
          The Scroll tab plays alerts newest-first and drops anything older than this, so what you
          swipe through is always current. Thirty minutes is the ceiling on purpose - past that, the
          token has usually stopped being the one the alert described. The deck simply empties on a
          quiet stretch rather than showing you stale calls.
        </span>
      </label>
    </div>
  );
}

/** Card-appearance preferences. Device-local - see PreferencesContext. */
function DisplayCard() {
  const { prefs, update } = usePreferences();

  return (
    <div className="settings-card">
      <h3>Display</h3>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.showThemeLabels}
          onChange={(e) => update({ showThemeLabels: e.target.checked })}
        />
        <span className="settings-toggle__text">
          <span className="settings-toggle__title">Show theme labels</span>
          <span className="settings-toggle__hint">
            The theme chips on each card (AI, MEME, DOG...). They're inferred from the token's name and
            description, so they're a decent hint and not a fact - off by default.
          </span>
        </span>
      </label>
    </div>
  );
}

const SOUND_LABELS: Record<AlertSoundName, string> = {
  cork: "Cork",
  ring: "Ring",
  bell: "Bell",
};

/** Audio alerting for the live feed. Device-local - see PreferencesContext. */
function SoundCard() {
  const { prefs, update } = usePreferences();

  /**
   * Every control here previews the sound it just changed, which is the only way to set a volume
   * without guessing. It also does the job the browser's autoplay policy requires: these clicks
   * are real user gestures, so the audio context comes out of `suspended` here rather than
   * silently swallowing the first real alert.
   */
  const preview = (patch: Partial<typeof prefs> = {}) => {
    const next = { ...prefs, ...patch };
    void unlockAudio().then(() => playAlertSound(next.alertSound, next.alertVolume));
  };

  const handleEnabledChange = (enabled: boolean) => {
    update({ alertSoundEnabled: enabled });
    if (enabled) preview({ alertSoundEnabled: true });
  };

  return (
    <div className="settings-card">
      <h3>Alert sound</h3>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={prefs.alertSoundEnabled}
          onChange={(e) => handleEnabledChange(e.target.checked)}
        />
        <span className="settings-toggle__text">
          <span className="settings-toggle__title">Play a sound on new alerts</span>
          <span className="settings-toggle__hint">
            Sounds once when a new token lands on the Live Feed, including while the tab is in the
            background. A burst of alerts at once gets one sound, not one each.
          </span>
        </span>
      </label>

      {prefs.alertSoundEnabled && (
        <>
          <div className="settings-sounds">
            {(Object.keys(SOUND_LABELS) as AlertSoundName[]).map((name) => (
              <button
                key={name}
                type="button"
                className={`settings-sound${prefs.alertSound === name ? " settings-sound--active" : ""}`}
                aria-pressed={prefs.alertSound === name}
                onClick={() => {
                  update({ alertSound: name });
                  preview({ alertSound: name });
                }}
              >
                {SOUND_LABELS[name]}
              </button>
            ))}
          </div>

          <label className="settings-card__select settings-volume">
            <span className="settings-volume__label">
              Volume
              <span className="settings-volume__value">{Math.round(prefs.alertVolume * 100)}%</span>
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round(prefs.alertVolume * 100)}
              onChange={(e) => update({ alertVolume: Number(e.target.value) / 100 })}
              /* Previewed on release, not on every step - dragging the slider would otherwise
                 fire twenty overlapping chimes. */
              onPointerUp={() => preview()}
              onKeyUp={() => preview()}
            />
          </label>

          <button className="btn settings-card__preview" type="button" onClick={() => preview()}>
            Test sound
          </button>
        </>
      )}
    </div>
  );
}
