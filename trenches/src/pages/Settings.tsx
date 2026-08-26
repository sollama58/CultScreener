import { useEffect, useState } from "react";
import { getTelegramStatus, linkTelegram, setAlertMode, unlinkTelegram } from "../api/client";
import type { AlertMode, TelegramStatus } from "../api/types";

const ALERT_MODE_LABELS: Record<AlertMode, string> = {
  REALTIME: "Real-time only",
  DIGEST: "Daily digest only",
  BOTH: "Real-time + daily digest",
  OFF: "Off",
};

export function Settings() {
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

  if (!status) return <p className="empty-state">Loading settings…</p>;

  // linkInfo only exists right after clicking "Link Telegram" this session; status.pendingLinkCode
  // survives a reload. Reconstruct the same deep link from status when linkInfo is gone so the
  // "Open Telegram" button doesn't disappear just because the page was refreshed mid-flow.
  const pendingCode = linkInfo?.linkCode ?? status.pendingLinkCode;
  const deepLink =
    linkInfo?.deepLink ??
    (status.botUsername && pendingCode ? `https://t.me/${status.botUsername}?start=${pendingCode}` : null);

  return (
    <div className="settings-page">
      <h2>Settings</h2>

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
    </div>
  );
}
