import type { CSSProperties } from "react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { acquireImageSlot } from "../utils/imageQueue";
import { useNow } from "../utils/useNow";
import { usePreferences } from "../context/PreferencesContext";
import type { CuratedMeta, Match } from "../api/types";
import { proxiedImageUrl } from "../api/images";
import { TokenArtwork } from "./TokenArtwork";
import { fmtUsd, fmtAge } from "../utils/format";
import { changeSinceAlertPct } from "../utils/feedFilter";

/**
 * `index` is the card's position in the grid, used only to stagger its entrance - see
 * .token-card--entering. Capped by the caller, not here, so a long page's last card is not
 * noticeably late.
 */
export function TokenCard({ match, index }: { match: Match; index?: number }) {
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
  const change = toChangeLabel(changeSinceAlertPct(match));

  return (
    /*
     * An <article>, not an <a>. The whole card used to be one link to DexScreener, which made
     * the copy button illegal HTML (interactive content cannot nest inside an anchor) and made
     * the quick links below impossible - nested anchors are not allowed and browsers unnest them.
     * The link moved onto the title instead, which is also the thing you would expect to click.
     */
    <article
      className={`token-card${match.curated ? " token-card--curated" : ""}${
        index === undefined ? "" : " token-card--entering"
      }`}
      style={index === undefined ? undefined : ({ "--card-index": index } as CSSProperties)}
    >
      {match.curated && <CuratedStrip curated={match.curated} standalone={match.kind === "curated"} />}
      <div className="token-card__header">
        <a className="token-card__title" href={dexUrl} target="_blank" rel="noreferrer">
          {/* The wrapper is the hover-preview's positioning context and must stay even when the
              artwork falls back to initials, so the header's layout never shifts. */}
          <span className="token-card__image-wrap">
            <TokenArtwork
              src={proxiedImageUrl(token.imageUrl)}
              label={ticker ?? name}
              className="token-card__image"
              fallbackClassName="token-card__image--empty"
            />
          </span>
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
        <WalletStat
          label="Fresh wallets"
          pct={snapshot.freshTop10WalletPct}
          checked={snapshot.top10WalletsChecked}
          tone="fresh"
          hint="Top-10 holders whose wallet was first funded in the last 24 hours - a sniper or insider signal."
        />
        <WalletStat
          label="Empty wallets"
          pct={snapshot.emptyTop10WalletPct}
          checked={snapshot.top10WalletsChecked}
          tone="empty"
          hint="Top-10 holders we cannot see $25 of holdings in besides this launch - wallets that look funded purely to hold it."
        />
        <div className="token-card__stat--wide">
          <dt>Alerted</dt>
          <dd className="token-card__alerted">
            <span>{new Date(match.matchedAt).toLocaleTimeString()}</span>
            <AlertAge matchedAt={match.matchedAt} />
          </dd>
        </div>
      </dl>

      <AthSection match={match} />

      {match.curated && match.kind === "curated" && <CuratedReasons reasons={match.curated.reasons} />}
      {match.curated && <CuratedOutcomeRow outcome={match.curated.outcome} />}

      <QuickLinks mint={token.mintAddress} />

      <div className="token-card__mint">
        <span className="token-card__mint-text">{token.mintAddress}</span>
        <CopyButton value={token.mintAddress} />
      </div>
    </article>
  );
}

/**
 * The banner that marks a card the curator picked, and how that call is going.
 *
 * `standalone` distinguishes the two ways a curated card reaches the Live Feed: on its own (the
 * curator picked a token none of this user's filters caught) or folded into one of their own
 * matches. Both wear the same tint - what matters is "the curator vouched for this" - but the
 * wording is honest about which happened.
 */
function CuratedStrip({ curated, standalone }: { curated: CuratedMeta; standalone: boolean }) {
  // "heuristic-v1" is the hand-tuned gate; anything else is the id of a promoted model. Worth a
  // visible mark, not just a tooltip: once the model takes the job, which curator made a given
  // call is exactly what the learning panel invites people to check.
  const modelPick = !curated.source.startsWith("heuristic");
  return (
    <div className="token-card__curated-strip">
      <span
        className="token-card__curated-label"
        title={
          curated.reasons.length > 0
            ? `Why: ${curated.reasons.join(" · ")}`
            : "Picked by the curator for the Curated Alerts feed"
        }
      >
        ★ Curated{standalone ? "" : " + your filter"}
        {modelPick && (
          <span className="token-card__curated-source" title={`Picked by the trained model (${curated.source}), not the hand-tuned gate.`}>
            model
          </span>
        )}
      </span>
      <OutcomeBadge curated={curated} />
    </div>
  );
}

/**
 * Why the curator picked this token, as visible chips rather than only a hover tooltip.
 *
 * Only rendered on standalone curated cards (the Curated tab, and curator-only cards in the Live
 * Feed): the title-attribute version above is unreachable on touch, and "why was this called" is
 * the first question a curated pick invites. Folded match+curated cards skip it - those cards
 * already carry the user's own filter as the reason they're here. Capped at three chips; the full
 * list stays in the strip's tooltip.
 */
function CuratedReasons({ reasons }: { reasons: string[] }) {
  if (reasons.length === 0) return null;
  const shown = reasons.slice(0, 3);
  const more = reasons.length - shown.length;
  return (
    <div className="token-card__curated-reasons" title={`Why the curator picked this: ${reasons.join(" · ")}`}>
      {shown.map((reason) => (
        <span key={reason} className="token-card__curated-reason">
          {reason}
        </span>
      ))}
      {more > 0 && <span className="token-card__curated-reason token-card__curated-reason--more">+{more}</span>}
    </div>
  );
}

/**
 * One of the two top-10 wallet signals, as a share and - when we know the denominator - a count.
 *
 * Three states, kept distinct on purpose. A percentage with a count ("40%  4 of 10") is the full
 * answer. A percentage alone is a snapshot written before the denominator was recorded, so the
 * count is omitted rather than guessed at ten - the list excludes pool and LP addresses and is
 * frequently shorter. And null is genuinely unknown: the holder list was unavailable, or the
 * per-cycle lookup budget deferred part of it. Unknown renders as a dash, never as 0%, because
 * "0% of holders are shells" is a claim and this is the absence of one.
 */
function WalletStat({
  label,
  pct,
  checked,
  tone,
  hint,
}: {
  label: string;
  pct: number | null;
  checked: number | null;
  tone: "fresh" | "empty";
  hint: string;
}) {
  const known = pct !== null;
  // Rounded from the percentage rather than carried separately - they are the same fact, and the
  // worker computes the percentage from exactly this denominator.
  const count = known && checked ? Math.round((pct / 100) * checked) : null;

  return (
    <div className="token-card__stat--wallet">
      <dt title={hint}>{label}</dt>
      <dd
        className={known ? `token-card__wallet token-card__wallet--${severity(pct, tone)}` : "token-card__wallet"}
        title={known ? hint : `${hint} Not known for this alert - the holder list could not be fully checked.`}
      >
        {known ? (
          <>
            <span className="token-card__wallet-pct">{Math.round(pct)}%</span>
            {count !== null && (
              <span className="token-card__wallet-count">
                {count} of {checked}
              </span>
            )}
          </>
        ) : (
          <span className="token-card__wallet-unknown">not checked</span>
        )}
      </dd>
    </div>
  );
}

/**
 * Colour bands. Both signals read the same direction - higher is worse - but they are not equally
 * damning at the same number, so they get their own thresholds: the Default filter allows up to
 * 40% fresh and 60% empty, and the bands are set either side of those so a card that passed the
 * starter filter does not glow red.
 */
function severity(pct: number, tone: "fresh" | "empty"): "ok" | "warn" | "bad" {
  const [warn, bad] = tone === "fresh" ? [25, 40] : [40, 60];
  if (pct > bad) return "bad";
  if (pct > warn) return "warn";
  return "ok";
}

/** The win window, in minutes - mirrors WIN_WINDOW_MINUTES in packages/core/src/curation/labels.ts. */
const WIN_WINDOW_MINUTES = 15;

/**
 * The verdict, or the countdown to it.
 *
 * The 2x flips the badge the moment it is observed rather than when the window formally closes -
 * waiting would mean showing "watching" to someone whose alert has already doubled. The
 * countdown ticks locally off the alert time (see useNow) instead of trusting a number computed
 * when the response was built, which would freeze between polls.
 */
function OutcomeBadge({ curated }: { curated: CuratedMeta }) {
  const now = useNow();
  const { outcome } = curated;

  // Checked before the 2x branch, not after: a disqualified alert BY DEFINITION also hit 2x
  // (you cannot be stopped out of a double you never had), so `hit2x` is true for every one of
  // them and an early win-return would paint the exact runs the label exists to count as losses
  // with a green badge - inflating the feed's visible record.
  if (outcome.status === "disqualified") {
    return (
      <span
        className="outcome-badge outcome-badge--missed"
        title="It did double inside the window - but only after first dropping 50%+, which would have stopped out anyone who bought the alert. Counted as a loss on purpose."
      >
        stopped out
      </span>
    );
  }

  if (outcome.hit2x) {
    // A win that went on to clear the 4x goal says so - it is the run the feed is hunting.
    return outcome.hitGoal ? (
      <span className="outcome-badge outcome-badge--won" title="Doubled inside 15 minutes and went on to 4x within the hour.">
        4x ✓
      </span>
    ) : (
      <span className="outcome-badge outcome-badge--won" title="Doubled within 15 minutes of the alert.">
        2x ✓
      </span>
    );
  }

  if (outcome.status === "watching") {
    const minutesLeft = Math.max(
      0,
      Math.ceil(WIN_WINDOW_MINUTES - (now - new Date(curated.alertedAt).getTime()) / 60_000),
    );
    return (
      <span
        className="outcome-badge outcome-badge--watching"
        title="A win means doubling within 15 minutes of the alert, without first dropping 50%. The run is then tracked for an hour to see if it reaches 4x."
      >
        watching · {minutesLeft}m
      </span>
    );
  }
  if (outcome.status === "missed") {
    return (
      <span
        className="outcome-badge outcome-badge--missed"
        title="Did not double within 15 minutes of the alert."
      >
        missed
      </span>
    );
  }
  return null;
}

/** The alert's own scorecard: how far it ran in its first hour (the 4x goal window), and the worst it got. */
function CuratedOutcomeRow({ outcome }: { outcome: CuratedMeta["outcome"] }) {
  if (outcome.peak1hReturnPct === null && outcome.maxDrawdown1hPct === null) return null;
  return (
    <div className="token-card__curated-outcome">
      <span>
        <span className="token-card__curated-outcome-label">1h peak</span>{" "}
        <span data-tone={toneOf(outcome.peak1hReturnPct)}>{fmtSignedPct(outcome.peak1hReturnPct)}</span>
      </span>
      <span>
        <span className="token-card__curated-outcome-label">worst</span>{" "}
        <span data-tone={toneOf(outcome.maxDrawdown1hPct)}>{fmtSignedPct(outcome.maxDrawdown1hPct)}</span>
      </span>
    </div>
  );
}

/** Gain/loss colouring for the scorecard numbers - same rounding threshold as the text itself,
 *  so a value that displays as "0%" never carries a colour claiming otherwise. */
function toneOf(n: number | null): "up" | "down" | undefined {
  if (n === null || !Number.isFinite(n)) return undefined;
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  if (rounded > 0) return "up";
  if (rounded < 0) return "down";
  return undefined;
}

function fmtSignedPct(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
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
 * Renders the % change the feed filter computes (see changeSinceAlertPct, which is shared so a
 * card and the filter can never disagree about the same number).
 *
 * That figure reflects however recently the worker last re-scanned this specific token - so it is
 * "as of the last data we actually have", not a live price feed. Null when there is nothing
 * newer than the alert-time snapshot to compare.
 */
function toChangeLabel(pct: number | null): { text: string; tone: "up" | "down" | "flat" } | null {
  if (pct === null) return null;
  const rounded = Math.round(pct);
  const tone = rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
  return { text: `${rounded > 0 ? "+" : ""}${rounded}%`, tone };
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

function scoreTier(score: number): "high" | "mid" | "low" {
  if (score >= 70) return "high";
  if (score >= 45) return "mid";
  return "low";
}
