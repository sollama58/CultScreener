import { useState, type FormEvent } from "react";
import type { FilterInput, PublicConfig, UserFilter } from "../api/types";

interface FilterFormProps {
  initial?: UserFilter;
  /** mcapFilterMin/Max seed a brand new filter's fields (the platform's advertised target band);
   *  scanBandMin/Max are the hard limits mcapMin/mcapMax can't be set outside of, since nothing
   *  out there would ever match anyway - see scanBand() in packages/core. */
  config: PublicConfig;
  onSave: (input: Partial<FilterInput>) => Promise<void>;
  onCancel?: () => void;
}

interface FormState {
  name: string;
  mcapMin: string;
  mcapMax: string;
  minVolumeMcapRatio: string;
  minHolderGrowthPct: string;
  maxTop10HolderPct: string;
  maxDevWalletPct: string;
  maxRiskScore: string;
  excludeCriticalRiskFlags: boolean;
  minTokenAgeMinutes: string;
  maxTokenAgeMinutes: string;
  narrativeKeywords: string;
  minScore: string;
  maxFreshTop10WalletPct: string;
  isActive: boolean;
}

function toFormState(config: PublicConfig, filter?: UserFilter): FormState {
  return {
    name: filter?.name ?? "New filter",
    // A brand new filter starts at the platform's own advertised target band, not the wider
    // padded limit - that's a ceiling you can opt into narrowing away from, not a suggestion.
    mcapMin: String(filter?.mcapMin ?? config.mcapFilterMin),
    mcapMax: String(filter?.mcapMax ?? config.mcapFilterMax),
    minVolumeMcapRatio: filter?.minVolumeMcapRatio?.toString() ?? "",
    minHolderGrowthPct: filter?.minHolderGrowthPct?.toString() ?? "",
    maxTop10HolderPct: filter?.maxTop10HolderPct?.toString() ?? "",
    maxDevWalletPct: filter?.maxDevWalletPct?.toString() ?? "",
    maxRiskScore: filter?.maxRiskScore?.toString() ?? "",
    excludeCriticalRiskFlags: filter?.excludeCriticalRiskFlags ?? false,
    minTokenAgeMinutes: filter?.minTokenAgeMinutes?.toString() ?? "",
    maxTokenAgeMinutes: filter?.maxTokenAgeMinutes?.toString() ?? "",
    narrativeKeywords: filter?.narrativeKeywords?.join(", ") ?? "",
    minScore: filter?.minScore?.toString() ?? "",
    maxFreshTop10WalletPct: filter?.maxFreshTop10WalletPct?.toString() ?? "",
    isActive: filter?.isActive ?? true,
  };
}

function toNumberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/** A small "ⓘ" next to a label, with the explanation as a native hover tooltip. Plain-language by
 *  design - these are read by everyday users deciding whether to touch a field, not just power
 *  users, so each one favors "what does this mean for me" over precise technical definitions. */
function Hint({ text }: { text: string }) {
  return (
    <span className="filter-form__hint" title={text}>
      ⓘ
    </span>
  );
}

export function FilterForm({ initial, config, onSave, onCancel }: FilterFormProps) {
  const [form, setForm] = useState<FormState>(() => toFormState(config, initial));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { scanBandMin, scanBandMax } = config;

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const mcapMin = Number(form.mcapMin);
    const mcapMax = Number(form.mcapMax);
    if (!Number.isFinite(mcapMin) || !Number.isFinite(mcapMax) || mcapMin >= mcapMax) {
      setError("Min market cap must be a number less than max market cap.");
      return;
    }
    if (mcapMin < scanBandMin || mcapMax > scanBandMax) {
      setError(
        `Market cap must be between $${scanBandMin.toLocaleString()} and $${scanBandMax.toLocaleString()} - ` +
          "TrenchScanner doesn't track tokens outside that range.",
      );
      return;
    }

    setSaving(true);
    try {
      await onSave({
        name: form.name.trim() || "Untitled filter",
        mcapMin,
        mcapMax,
        minVolumeMcapRatio: toNumberOrNull(form.minVolumeMcapRatio),
        minHolderGrowthPct: toNumberOrNull(form.minHolderGrowthPct),
        maxTop10HolderPct: toNumberOrNull(form.maxTop10HolderPct),
        maxDevWalletPct: toNumberOrNull(form.maxDevWalletPct),
        maxRiskScore: toNumberOrNull(form.maxRiskScore),
        excludeCriticalRiskFlags: form.excludeCriticalRiskFlags,
        minTokenAgeMinutes: toNumberOrNull(form.minTokenAgeMinutes),
        maxTokenAgeMinutes: toNumberOrNull(form.maxTokenAgeMinutes),
        narrativeKeywords: form.narrativeKeywords
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean),
        minScore: toNumberOrNull(form.minScore),
        maxFreshTop10WalletPct: toNumberOrNull(form.maxFreshTop10WalletPct),
        isActive: form.isActive,
      });
    } catch {
      setError("Couldn't save this filter. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="filter-form" onSubmit={handleSubmit}>
      <div className="filter-form__row">
        <label>
          Filter name
          <input value={form.name} onChange={(e) => update("name", e.target.value)} required />
        </label>
        <label className="filter-form__checkbox">
          <input
            type="checkbox"
            checked={form.isActive}
            onChange={(e) => update("isActive", e.target.checked)}
          />
          Active
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Min market cap ($)
            <Hint text="The smallest market cap a token can have to reach you. TrenchScanner never sees tokens below the platform-wide floor shown above, so this can't go lower than that." />
          </span>
          <input
            type="number"
            min={scanBandMin}
            max={scanBandMax}
            value={form.mcapMin}
            onChange={(e) => update("mcapMin", e.target.value)}
            required
          />
        </label>
        <label>
          <span className="filter-form__label-row">
            Max market cap ($)
            <Hint text="The largest market cap a token can have to reach you. TrenchScanner never sees tokens above the platform-wide ceiling shown above, so this can't go higher than that." />
          </span>
          <input
            type="number"
            min={scanBandMin}
            max={scanBandMax}
            value={form.mcapMax}
            onChange={(e) => update("mcapMax", e.target.value)}
            required
          />
        </label>
      </div>
      <p className="filter-form__caption">
        Must be within ${scanBandMin.toLocaleString()}–${scanBandMax.toLocaleString()} - see the explanation
        at the top of this page for why.
      </p>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Min volume/mcap ratio
            <Hint text="How much the token is trading relative to its size, over the last 24 hours. A ratio of 1 means its trading volume roughly equals its whole market cap that day - a sign of real, active trading rather than a quiet chart nobody's touching. Leave blank to not check this." />
          </span>
          <input
            type="number"
            step="0.1"
            placeholder="e.g. 0.5"
            value={form.minVolumeMcapRatio}
            onChange={(e) => update("minVolumeMcapRatio", e.target.value)}
          />
        </label>
        <label>
          <span className="filter-form__label-row">
            Min holder growth %
            <Hint text="How much the number of holders has grown recently. A rising holder count usually means new buyers are discovering the token, which is a good early sign. Leave blank to not check this." />
          </span>
          <input
            type="number"
            placeholder="e.g. 10"
            value={form.minHolderGrowthPct}
            onChange={(e) => update("minHolderGrowthPct", e.target.value)}
          />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Min score (0-100)
            <Hint text="TrenchScanner's own 0-100 score for breakout potential - it blends price/volume momentum, holder growth, token age, and narrative into one number. This is not a safety score; a token can score high here and still carry risks you'd only catch with the RugCheck-derived fields below. Leave blank to see tokens at any score." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 60"
            value={form.minScore}
            onChange={(e) => update("minScore", e.target.value)}
          />
        </label>
        <label>
          <span className="filter-form__label-row">
            Max fresh top-10 wallets %
            <Hint text="What share of the 10 biggest wallet-holders were only just created (funded less than 24 hours ago). A lot of brand-new wallets among the biggest holders can mean insiders or a bot grabbed a large chunk right at launch, rather than real buyers. Leave blank to not check this - and note it's left unchecked automatically whenever we don't have enough wallet data for a token." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 30"
            value={form.maxFreshTop10WalletPct}
            onChange={(e) => update("maxFreshTop10WalletPct", e.target.value)}
          />
        </label>
      </div>

      <p className="filter-form__section-label">
        Extra risk checks (optional)
        <Hint text="These four are additional safety checks you can turn on if you want to be more cautious than our baseline screen. They used to be mandatory for everyone, but people reasonably disagree on how much risk is too much here, so now it's your call. Leaving one blank simply skips that check - it's never counted against a token." />
      </p>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Max top-10 holder %
            <Hint text="How much of the total supply the 10 biggest wallets hold combined (not counting the liquidity pool). The higher this is, the easier it is for a handful of wallets to crash the price by selling at the same time. Leave blank to not check this." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 40"
            value={form.maxTop10HolderPct}
            onChange={(e) => update("maxTop10HolderPct", e.target.value)}
          />
        </label>
        <label>
          <span className="filter-form__label-row">
            Max dev wallet %
            <Hint text="How much of the supply the token's own creator personally holds. A high number here means the creator could dump a lot of supply on the market at once. If this is blank on a token, it usually just means the creator's wallet is too small to rank among the top 10 holders - a good sign, not a gap in the data." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 15"
            value={form.maxDevWalletPct}
            onChange={(e) => update("maxDevWalletPct", e.target.value)}
          />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Max RugCheck risk score
            <Hint text="A 0-100 risk score from RugCheck, an independent token-safety scanner (higher = riskier). It looks for things we don't check ourselves, like wallets that look coordinated or suspicious buying patterns right after launch. Don't confuse this with the score field above - that one measures upside potential, this one measures risk." />
          </span>
          <input
            type="number"
            min={0}
            max={100}
            placeholder="e.g. 70"
            value={form.maxRiskScore}
            onChange={(e) => update("maxRiskScore", e.target.value)}
          />
        </label>
        <label className="filter-form__checkbox">
          <input
            type="checkbox"
            checked={form.excludeCriticalRiskFlags}
            onChange={(e) => update("excludeCriticalRiskFlags", e.target.checked)}
          />
          Exclude critical risk flags
          <Hint text="When checked, hides any token whose creator RugCheck has flagged as either having rug-pulled a previous token before, or whose identity can't be determined at all. These are the two most serious warning signs RugCheck reports." />
        </label>
      </div>

      <div className="filter-form__row">
        <label>
          <span className="filter-form__label-row">
            Min age (minutes)
            <Hint text="How long ago the token launched, at minimum. Set this to skip brand-new tokens and only see ones that have had a little time to prove themselves. Leave blank to see tokens of any age." />
          </span>
          <input
            type="number"
            min={0}
            placeholder="e.g. 30"
            value={form.minTokenAgeMinutes}
            onChange={(e) => update("minTokenAgeMinutes", e.target.value)}
          />
        </label>
        <label>
          <span className="filter-form__label-row">
            Max age (minutes)
            <Hint text="How long ago the token launched, at most. Set this if you only want fresh opportunities and don't care about tokens that have been around for a while. Leave blank to see tokens of any age." />
          </span>
          <input
            type="number"
            min={0}
            placeholder="e.g. 2880"
            value={form.maxTokenAgeMinutes}
            onChange={(e) => update("maxTokenAgeMinutes", e.target.value)}
          />
        </label>
      </div>

      <label>
        <span className="filter-form__label-row">
          Narrative keywords (comma-separated, optional)
          <Hint text="Only match tokens whose name, symbol, or detected theme contains one of these words - handy for following a trend (like a specific meme or event) as it plays out. Leave blank to match on any theme." />
        </span>
        <input
          placeholder="e.g. dog, ai, trump"
          value={form.narrativeKeywords}
          onChange={(e) => update("narrativeKeywords", e.target.value)}
        />
      </label>

      {error && <p className="form-error">{error}</p>}

      <div className="filter-form__actions">
        <button type="submit" className="btn btn--primary" disabled={saving}>
          {saving ? "Saving…" : "Save filter"}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}
