import { useEffect, useRef, useState, type MouseEvent } from "react";
import { acquireImageSlot } from "../utils/imageQueue";
import { useNow } from "../utils/useNow";
import { usePreferences } from "../context/PreferencesContext";
import type { Match } from "../api/types";
import { fmtUsd, fmtAge } from "../utils/format";

export function TokenCard({ match }: { match: Match }) {
  const { prefs } = usePreferences();
  const { token, snapshot, latestSnapshot } = match;
  const name = token.name ?? token.symbol ?? token.mintAddress.slice(0, 8);
  // Some DexScreener symbols already carry a leading "$" ("$WIF", "$michi"), and the card adds
  // its own - which rendered as "$$WIF". Strip it once here so both the label and the fallback
  // tile's initials work from the bare ticker.
  const ticker = token.symbol?.replace(/^\$+/, "") || null;
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
    /*
     * An <article>, not an <a>. The whole card used to be one link to DexScreener, which made
     * the copy button illegal HTML (interactive content cannot nest inside an anchor) and made
     * the quick links below impossible - nested anchors are not allowed and browsers unnest them.
     * The link moved onto the title instead, which is also the thing you would expect to click.
     */
    <article className="token-card">
      <div className="token-card__header">
        <a className="token-card__title" href={dexUrl} target="_blank" rel="noreferrer">
          <TokenImage src={token.imageUrl} label={ticker ?? name} />
          <span className="token-card__title-text">
            <span className="token-card__name" title={name}>
              {name}
            </span>
            {ticker && <span className="token-card__symbol">${ticker}</span>}
          </span>
        </a>
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
        {prefs.showThemeLabels &&
          token.narrativeTags.map((tag) => (
            <span key={tag} className="tag">
              {tag}
            </span>
          ))}
        {token.hasTwitter && <span className="tag tag--muted">𝕏</span>}
        {token.hasTelegram && <span className="tag tag--muted">TG</span>}
      </div>

      <dl className="token-card__stats">
        <div className="token-card__stat--hero">
          <dt>Alerted at</dt>
          <dd title={`Market cap when this match was found: ${new Date(match.matchedAt).toLocaleString()}`}>
            {fmtUsd(snapshot.marketCapUsd)}
          </dd>
        </div>
        <div className="token-card__stat--hero">
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
          <dt>Age</dt>
          <dd>
            <TokenAge ageMinutes={snapshot.ageMinutes} takenAt={snapshot.takenAt} />
          </dd>
        </div>
        <div className="token-card__stat--wide">
          <dt>Alerted</dt>
          <dd className="token-card__alerted">
            <span>{new Date(match.matchedAt).toLocaleTimeString()}</span>
            <AlertAge matchedAt={match.matchedAt} />
          </dd>
        </div>
      </dl>

      <AthSection match={match} />

      <ScoreBreakdown snapshot={snapshot} />

      <QuickLinks mint={token.mintAddress} />

      <div className="token-card__mint">
        <span className="token-card__mint-text">{token.mintAddress}</span>
        <CopyButton value={token.mintAddress} />
      </div>
    </article>
  );
}

/**
 * The token's logo, falling back to its initials.
 *
 * The fallback covers two different situations that look the same on screen and must not be
 * distinguished: DexScreener has no artwork for the mint (common for brand-new tokens), and it has
 * a URL that fails to load. An earlier version only handled the first, and hid the image on error
 * - which left a hole in the header exactly where the tile should be, and only in the case where
 * something had already gone wrong.
 */
function TokenImage({ src, label }: { src?: string | null; label: string }) {
  const [failed, setFailed] = useState(false);
  // Held back until the queue says go, so a page of twelve cards doesn't hit a public IPFS
  // gateway with twelve simultaneous requests - see imageQueue.ts.
  const [started, setStarted] = useState(false);
  // The slot has to be released the moment the image settles, not when the card unmounts: a
  // loaded image that keeps its slot would mean only MAX_CONCURRENT images ever appear and the
  // rest sit queued until their timeout. The ref is what lets onLoad/onError reach it.
  const releaseRef = useRef<(() => void) | undefined>(undefined);

  useEffect(() => {
    if (!src) return;
    setStarted(false);
    setFailed(false);
    let cancelled = false;

    void acquireImageSlot().then((release) => {
      // Unmounted, or re-rendered onto a different token, while queued: give the slot straight
      // back rather than letting a load nobody is waiting for hold it.
      if (cancelled) {
        release();
        return;
      }
      releaseRef.current = release;
      setStarted(true);
    });

    return () => {
      cancelled = true;
      releaseRef.current?.();
      releaseRef.current = undefined;
    };
  }, [src]);

  const settle = () => {
    releaseRef.current?.();
    releaseRef.current = undefined;
  };

  // Both branches sit in the same wrapper so the header's layout doesn't shift depending on
  // whether a logo exists, and so the hover preview has one positioning context to anchor to.
  return (
    <span className="token-card__image-wrap">
      {!src || failed ? (
        <span className="token-card__image token-card__image--empty" aria-hidden="true">
          {label.slice(0, 2).toUpperCase()}
        </span>
      ) : (
        <img
          className="token-card__image"
          // Rendered from the start so the box reserves its space, but with no src until the
          // queue releases it - an <img> with no src requests nothing.
          src={started ? src : undefined}
          alt=""
          decoding="async"
          onLoad={settle}
          onError={() => {
            settle();
            setFailed(true);
          }}
        />
      )}
    </span>
  );
}

/**
 * How old the *token* is, right now.
 *
 * The snapshot stores `ageMinutes` as it stood the moment that snapshot was taken, which for the
 * alert-time snapshot means age-at-alert. Rendering that directly - which this card used to do -
 * froze the number: a token alerted at 40 minutes old still read "40m" hours later, and two
 * tokens alerted a day apart could show the same age while being wildly different things.
 *
 * Adding the time elapsed since the snapshot recovers the real figure exactly, because
 * `takenAt - ageMinutes` is the token's creation time: the worker derives `ageMinutes` as
 * `now - createdAt` in the same scan cycle that writes `takenAt`. So this is the true age, not
 * an estimate of it, and it stays true without the server having to re-send anything.
 */
function TokenAge({ ageMinutes, takenAt }: { ageMinutes: number | null; takenAt: string }) {
  const now = useNow();

  if (ageMinutes === null || !Number.isFinite(ageMinutes)) return <>—</>;

  const takenAtMs = new Date(takenAt).getTime();
  // An unparseable timestamp shouldn't turn a real age into a dash - fall back to the stored
  // figure, which is at worst stale rather than wrong.
  if (!Number.isFinite(takenAtMs)) return <>{fmtAge(ageMinutes)}</>;

  const sinceSnapshotMinutes = Math.max(0, (now - takenAtMs) / 60_000);
  return <>{fmtAge(Math.round(ageMinutes + sinceSnapshotMinutes))}</>;
}

/** How old an alert may get before its age changes colour. */
const ALERT_AGE_FRESH_MS = 60_000;
const ALERT_AGE_RECENT_MS = 5 * 60_000;

/**
 * Time since the alert fired, ticking once a second.
 *
 * Counts from match.matchedAt, which is set server-side and never moves, so this measures how
 * long ago the token actually qualified rather than how long this tab has been open - a card
 * loaded from page 3 half an hour later still reads correctly.
 *
 * The clock is shared across every card (see useNow) so they tick together rather than drifting
 * a fraction of a second apart from each other.
 */
function AlertAge({ matchedAt }: { matchedAt: string }) {
  const now = useNow();
  const elapsedMs = now - new Date(matchedAt).getTime();

  // A clock skew between server and browser can put an alert marginally in the future; showing a
  // negative duration would look broken, so it floors at zero and reads as brand new.
  const safeMs = Math.max(0, elapsedMs);
  const tone = safeMs < ALERT_AGE_FRESH_MS ? "fresh" : safeMs < ALERT_AGE_RECENT_MS ? "recent" : "stale";

  return (
    <span
      className="token-card__age"
      data-tone={tone}
      title={`Alerted ${new Date(matchedAt).toLocaleString()}`}
    >
      {formatElapsed(safeMs)}
    </span>
  );
}

/** HH:MM:SS. Hours are not capped at 24 - an alert from yesterday should read 27:12:04, not
 *  03:12:04, which would be indistinguishable from one three hours old. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/** Where to go to actually trade the thing, since every one of these takes the raw mint address. */
const TRADING_PLATFORMS: { label: string; href: (mint: string) => string }[] = [
  { label: "PumpFun", href: (m) => `https://pump.fun/coin/${m}` },
  { label: "Terminal", href: (m) => `https://trade.padre.gg/trade/solana/${m}` },
  { label: "FOMO", href: (m) => `https://fomo.family/tokens/solana/${m}` },
  { label: "Axiom", href: (m) => `https://axiom.trade/t/${m}` },
];

function QuickLinks({ mint }: { mint: string }) {
  return (
    <div className="token-card__links">
      <span className="token-card__links-label">Quick links</span>
      <span className="token-card__links-row">
        {TRADING_PLATFORMS.map((p) => (
          <a
            key={p.label}
            className="token-card__link"
            href={p.href(mint)}
            target="_blank"
            /* noreferrer as well as noopener: these are third-party trading sites, and there is no
               reason to hand them the referring URL. */
            rel="noreferrer"
          >
            {p.label}
          </a>
        ))}
      </span>
    </div>
  );
}

/**
 * Compares the frozen alert-time mcap against the freshest figure the server has (see nowMcap
 * above). That figure reflects however recently the worker last re-scanned this specific token
 * (every ~7 minutes while it's still in the mcap band, per SCAN_INTERVAL_MINUTES - not at all
 * once it falls out of band) - so this is "as of the last data we actually have," not a live
 * price feed. Undefined/null when there's nothing newer than the alert-time snapshot to compare.
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
 * The highest market cap this token has reached since the match.
 *
 * Recorded every scan cycle - about once a minute - from the snapshot and live-ping history the
 * backend already holds (apps/worker/src/jobs/matchPeaks.ts); a nightly job covers the long tail
 * of tokens that have dropped out of the scanned band. It used to be daily, and this comment used
 * to say so: worth correcting rather than deleting, because "can lag up to a day behind" is
 * exactly the sort of note that makes a genuinely stale number look expected. It was - the
 * percentage was frozen at its first value while the dollar figure kept climbing.
 *
 * Null (and this section hidden entirely) until the token has traded above its alert market cap
 * at all - "no ATH recorded yet" is not the same as "never went up", and neither is "+0%".
 *
 * peakMcapUsd only ever moves up from snapshot.marketCapUsd, so the % here is always a gain. This
 * is a record of the best it has done, not a live price.
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
  // Momentum only. Holder health, age and narrative all still feed the composite score shown in
  // the header - they are just no longer broken out here, where four abbreviated bars cost more
  // attention than they returned. One bar has room for its real name.
  const bars: { label: string; title: string; value: number | null }[] = [
    { label: "Momentum", title: "Momentum (volume/mcap ratio, buy pressure)", value: snapshot.scoreMomentum },
  ];

  // Older snapshots (pre-breakdown-tracking) won't have this - skip the row entirely rather
  // than show an empty bar.
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
