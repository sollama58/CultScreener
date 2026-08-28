import { useEffect, useRef } from "react";
import type { PublicConfig } from "../api/types";

/**
 * A ready-made filter configuration.
 *
 * `settings` is deliberately a partial: a template names only the fields it has an opinion
 * about, and everything it leaves out keeps whatever the form already had. That is what lets
 * "Wide Filters" mean "two criteria and nothing else" rather than silently pinning the other
 * dozen fields to values nobody chose.
 */
export interface FilterTemplate {
  id: string;
  name: string;
  description: string;
  /** Shown on the card so the effect is visible before applying, not after. */
  summary: string[];
  settings: TemplateSettings;
}

export interface TemplateSettings {
  minVolumeMcapRatio?: number | null;
  minHolderGrowthPct?: number | null;
  maxTop10HolderPct?: number | null;
  maxDevWalletPct?: number | null;
  maxRiskScore?: number | null;
  excludeCriticalRiskFlags?: boolean;
  minTokenAgeMinutes?: number | null;
  maxTokenAgeMinutes?: number | null;
  minScore?: number | null;
  maxFreshTop10WalletPct?: number | null;
  maxEmptyTop10WalletPct?: number | null;
  narrativeKeywords?: string;
  mcapMin?: number;
  mcapMax?: number;
}

/**
 * Every criterion the form offers, so a template can say "and nothing else" by clearing them.
 *
 * Applying a template has to be a complete statement, not a merge: if you pick a deliberately
 * loose template while a strict one is on screen, quietly keeping the strict fields the template
 * happens not to mention would give you neither configuration. So a template starts from this
 * cleared baseline and layers its own values on top.
 */
const CLEARED: TemplateSettings = {
  minVolumeMcapRatio: null,
  minHolderGrowthPct: null,
  maxTop10HolderPct: null,
  maxDevWalletPct: null,
  maxRiskScore: null,
  excludeCriticalRiskFlags: false,
  minTokenAgeMinutes: null,
  maxTokenAgeMinutes: null,
  minScore: null,
  maxFreshTop10WalletPct: null,
  maxEmptyTop10WalletPct: null,
  narrativeKeywords: "",
};

export const FILTER_TEMPLATES: FilterTemplate[] = [
  {
    id: "wide",
    name: "Wide Filters",
    description:
      "Catches almost everything the scanner screens. Two loose guards only - a cap on brand-new wallets among the top holders, and enough age that the token has at least been seen twice.",
    summary: ["Max fresh top-10 wallets 30%", "Min age 1 minute", "Every other criterion left open"],
    settings: { maxFreshTop10WalletPct: 30, maxEmptyTop10WalletPct: 60, minTokenAgeMinutes: 1 },
  },
];

/** Merge a template over the cleared baseline - see CLEARED for why it isn't a plain merge. */
export function templateSettings(template: FilterTemplate, config: PublicConfig): TemplateSettings {
  return {
    ...CLEARED,
    // Market cap is never blank - the form requires a band - so it falls back to the platform's
    // own advertised range rather than to nothing.
    mcapMin: config.mcapFilterMin,
    mcapMax: config.mcapFilterMax,
    ...template.settings,
  };
}

interface Props {
  config: PublicConfig;
  onApply: (template: FilterTemplate) => void;
  onClose: () => void;
}

/** Picker for the templates above. Applying one fills the form; nothing is saved until you save. */
export function FilterTemplates({ config, onApply, onClose }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null);

  // Escape closes, and focus moves into the dialog so a keyboard user isn't left behind on the
  // page underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    dialogRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      // Only a click that both starts and ends on the backdrop closes it - otherwise a text
      // selection that drifts outside the dialog dismisses the whole thing.
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="filter-templates-title"
        tabIndex={-1}
        ref={dialogRef}
      >
        <div className="modal__head">
          <h3 id="filter-templates-title">Start from a template</h3>
          <button className="modal__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        <p className="modal__lede">
          Fills the form below - nothing is saved until you press Save filter, so you can adjust
          anything first.
        </p>

        <ul className="template-list">
          {FILTER_TEMPLATES.map((template) => (
            <li key={template.id}>
              <button type="button" className="template-card" onClick={() => onApply(template)}>
                <span className="template-card__name">{template.name}</span>
                <span className="template-card__description">{template.description}</span>
                <ul className="template-card__summary">
                  {template.summary.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </button>
            </li>
          ))}
        </ul>
        {/* config is threaded through for the market-cap fallback in templateSettings. */}
        <p className="modal__foot">
          Market cap defaults to the scanner's own band, ${config.mcapFilterMin.toLocaleString()} - $
          {config.mcapFilterMax.toLocaleString()}.
        </p>
      </div>
    </div>
  );
}
