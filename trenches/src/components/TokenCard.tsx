import { useState, type MouseEvent } from "react";
import type { Match } from "../api/types";
import { fmtUsd, fmtPct, fmtAge } from "../utils/format";

export function TokenCard({ match }: { match: Match }) {
  const { token, snapshot, latestSnapshot } = match;
  const name = token.name ?? token.symbol ?? token.mintAddress.slice(0, 8);
  const dexUrl = `https://dexscreener.com/solana/${token.pairAddress ?? token.mintAddress}`;
  const change = pctChangeSinceAlert(snapshot.marketCapUsd, latestSnapshot?.marketCapUsd);

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
              latestSnapshot
                ? `As of the worker's most recent scan of this token: ${new Date(latestSnapshot.takenAt).toLocaleString()}`
                : "No scan of this token since it matched yet"
            }
          >
            {latestSnapshot ? fmtUsd(latestSnapshot.marketCapUsd) : "—"}
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
 * `latestSnapshot` reflects however recently the worker last re-scanned this specific token
 * (every ~7 minutes while it's still in the mcap band, per SCAN_INTERVAL_MINUTES - not at all
 * once it falls out of band) - so this is "as of the last data we actually have," not a live
 * price feed. Undefined/null when there's nothing newer than the alert-time snapshot to compare.
 */
function pctChangeSinceAlert(
  alertMcap: number,
  nowMcap: number | undefined,
): { text: string; tone: "up" | "down" | "flat" } | null {
  if (nowMcap === undefined || alertMcap <= 0) return null;
  const pct = Math.round(((nowMcap - alertMcap) / alertMcap) * 100);
  const tone = pct > 0 ? "up" : pct < 0 ? "down" : "flat";
  return { text: `${pct > 0 ? "+" : ""}${pct}%`, tone };
}

/**
 * The highest market cap this token has reached since the match, tracked daily by
 * apps/worker/src/jobs/outcomeTrackingJob.ts. Null (and this section hidden entirely) until that
 * job's first run after the match - "no ATH recorded yet" is not the same as "never went up."
 * peakMcapUsd only ever moves up from snapshot.marketCapUsd, so the % here is always a gain -
 * this is a record of the best it's done, not a live price, and can lag up to a day behind.
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

/** Copies the mint address to the clipboard - stops the click from also triggering the card's
 *  own link-out to DexScreener, since the whole card is one big <a>. */
function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const handleClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {
        // Clipboard access can be denied (permissions, insecure context) - nothing to recover
        // into here beyond just not showing the "Copied!" confirmation.
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
