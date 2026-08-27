import { useState, type MouseEvent } from "react";
import type { Match } from "../api/types";
import { fmtUsd, fmtPct, fmtAge } from "../utils/format";

export function TokenCard({ match }: { match: Match }) {
  const { token, snapshot, latestSnapshot } = match;
  const name = token.name ?? token.symbol ?? token.mintAddress.slice(0, 8);
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress ?? token.mintAddress}`;
  // The server already reconciled the live ping against the latest snapshot; re-deriving that
  // here is wrong once a token drops out of the viewed set. Fall back to latestSnapshot only if
  // the field is absent entirely (older API deploy) — a `null` from the server is authoritative
  // and means "no figure", not "go look somewhere else".
  const nowMcap =
    match.currentMarketCapUsd !== undefined
      ? match.currentMarketCapUsd
      : (latestSnapshot?.marketCapUsd ?? null);
  const nowMcapAt = match.currentMarketCapAt ?? latestSnapshot?.takenAt ?? null;
  const change = pctChangeSinceAlert(snapshot.marketCapUsd, nowMcap);

  return (
    <a className="token-card" href={dexUrl} target="_blank" rel="noreferrer">
      <div className="token-card__header">
        <div>
          <span className="token-card__name">{name}</span>
          {token.symbol && <span className="token-card__symbol">${token.symbol}</span>}
        </div>
        <span className="token-card__score" data-tier={scoreTier(match.score)}>
          {match.score.toFixed(0)}
        </span>
      </div>

      <div className="token-card__tags">
        {snapshot.graduated !== null && (
          <span
            className="tag tag--muted"
            title={
              snapshot.graduated
                ? "Graduated off the Pump.fun bonding curve to a real AMM"
                : "Still trading on the Pump.fun bonding curve - not yet graduated"
            }
          >
            {snapshot.graduated ? "Graduated" : "Bonding"}
          </span>
        )}
        {token.narrativeTags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
        {token.hasTwitter && <span className="tag tag--muted">𝕏</span>}
        {token.hasTelegram && <span className="tag tag--muted">TG</span>}
      </div>

      <dl className="token-card__stats">
        <div>
          <dt>Alerted at</dt>
          <dd title={`Market cap when this match was found: ${new Date(match.matchedAt).toLocaleString()}`}>
            {fmtUsd(snapshot.marketCapUsd)}
          </dd>
        </div>
        <div>
          <dt>Now</dt>
          <dd
            className={change ? `token-card__change--${change.tone}` : undefined}
            title={
              nowMcapAt
                ? `Freshest market cap the scanner has for this token: ${new Date(nowMcapAt).toLocaleString()}`
                : "No fresher market cap than the alert-time one yet"
            }
          >
            {fmtUsd(nowMcap)}
            {change && ` (${change.text})`}
          </dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd>{fmtUsd(snapshot.volume24hUsd)}</dd>
        </div>
        <div>
          <dt>Holders</dt>
          <dd>{snapshot.holderCount ?? "—"}</dd>
        </div>
        <div>
          <dt>Top 10</dt>
          <dd>{fmtPct(snapshot.top10HolderPct)}</dd>
        </div>
        <div>
          <dt>Age</dt>
          <dd>{fmtAge(snapshot.ageMinutes)}</dd>
        </div>
        <div>
          <dt>Matched</dt>
          <dd>{new Date(match.matchedAt).toLocaleTimeString()}</dd>
        </div>
      </dl>

      <AthSection match={match} />

      <ScoreBreakdown snapshot={snapshot} />

      <div className="token-card__mint">
        <span className="token-card__mint-text">{token.mintAddress}</span>
        <CopyButton value={token.mintAddress} />
      </div>
    </a>
  );
}

/**
 * Compares the frozen alert-time mcap against the freshest figure the server has (see nowMcap
 * above). That figure reflects however recently the worker last re-scanned this specific token
 * (SCAN_INTERVAL_MINUTES, now every minute) and, for tokens someone is actively viewing, the
 * separate once-a-minute live-price ping - so this is "as of the last data we actually have,"
 * not a continuous feed. Null when there's nothing newer than the alert-time snapshot.
 */
function pctChangeSinceAlert(
  alertMcap: number,
  nowMcap: number | null | undefined,
): { text: string; tone: "up" | "down" | "flat" } | null {
  if (nowMcap === undefined || nowMcap === null || !Number.isFinite(nowMcap) || alertMcap <= 0) {
    return null;
  }
  const pct = Math.round(((nowMcap - alertMcap) / alertMcap) * 100);
  const tone = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, tone };
}

/**
 * The highest market cap this token has reached since the match. Rolled forward every scan cycle
 * (recordMatchPeaks, called from the worker's scanJob) rather than by a daily job, so it now
 * tracks within about a minute. Null - and this section hidden entirely - until the first cycle
 * after the match: "no ATH recorded yet" is not the same as "never went up." peakMcapUsd only
 * ever moves up from snapshot.marketCapUsd, so the % here is always a gain.
 */
function AthSection({ match }: { match: Match }) {
  const { snapshot } = match;
  if (match.peakMcapUsd === null || snapshot.marketCapUsd <= 0) return null;

  const pct =
    match.peakReturnPct ?? ((match.peakMcapUsd - snapshot.marketCapUsd) / snapshot.marketCapUsd) * 100;

  return (
    <div className="token-card__ath">
      <div className="token-card__ath-label">All-Time High (after alert)</div>
      <div className="token-card__ath-value">
        {fmtUsd(match.peakMcapUsd)}
        <span className="token-card__ath-pct">+{Math.round(pct)}%</span>
      </div>
      {match.peakMcapAt && (
        <div className="token-card__ath-meta" title={new Date(match.peakMcapAt).toLocaleString()}>
          as of {new Date(match.peakMcapAt).toLocaleDateString()}
        </div>
      )}
    </div>
  );
}

/**
 * Copies text, falling back to a hidden textarea + execCommand where the async Clipboard API
 * isn't there.
 *
 * `navigator.clipboard` is undefined outside a secure context and in a number of in-app
 * webviews — Telegram's and X's among them, which is exactly where a memecoin CA gets opened.
 * Reaching straight for `navigator.clipboard.writeText` throws a TypeError on the property
 * access itself, *before* any promise exists, so a trailing `.catch()` never sees it: the click
 * just dies with an uncaught error. Copying the CA was an explicit product requirement, so it
 * gets a real fallback rather than silently doing nothing.
 */
async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Denied or unavailable — fall through to the legacy path below.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = value;
    // Keep it off-screen and non-focusable-looking so the page doesn't visibly jump.
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Copies the mint address to the clipboard - stops the click from also triggering the card's
 *  own link-out to DexScreener, since the whole card is one big <a>. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void copyText(value).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      className="token-card__copy"
      onClick={handleClick}
      title="Copy contract address"
      aria-label="Copy contract address"
    >
      {copied ? "Copied!" : "Copy CA"}
    </button>
  );
}

/** Why the token scored the way it did - the 4 components behind the single number in the header. */
function ScoreBreakdown({
  snapshot,
}: {
  snapshot: {
    scoreMomentum: number | null;
    scoreHolderHealth: number | null;
    scoreAge: number | null;
    scoreNarrative: number | null;
  };
}) {
  const bars: { label: string; title: string; value: number | null }[] = [
    { label: "Mom", title: "Momentum (volume/mcap ratio, buy pressure)", value: snapshot.scoreMomentum },
    { label: "Hold", title: "Holder health (growth, concentration)", value: snapshot.scoreHolderHealth },
    { label: "Age", title: "Age (sweet spot vs. too new/too mature)", value: snapshot.scoreAge },
    { label: "Narr", title: "Narrative (theme + social presence)", value: snapshot.scoreNarrative },
  ];

  // Older snapshots (pre-breakdown-tracking) won't have these - skip the row entirely rather
  // than show four empty bars.
  if (bars.every((b) => b.value === null)) return null;

  return (
    <div className="token-card__breakdown">
      {bars.map((bar) => (
        <div
          key={bar.label}
          className="breakdown-bar"
          title={`${bar.title}: ${bar.value?.toFixed(0) ?? "—"}`}
        >
          <span className="breakdown-bar__label">{bar.label}</span>
          <span className="breakdown-bar__track">
            <span
              className="breakdown-bar__fill"
              style={{ width: `${Math.max(0, Math.min(100, bar.value ?? 0))}%` }}
            />
          </span>
        </div>
      ))}
    </div>
  );
}

function scoreTier(score: number): "high" | "mid" | "low" {
  if (score >= 70) return "high";
  if (score >= 45) return "mid";
  return "low";
}
