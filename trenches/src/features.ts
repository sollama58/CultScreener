/**
 * Build-time feature switches for UI whose backend isn't live yet.
 *
 * TELEGRAM: TrenchScanner's API has no /telegram/* routes, no admin unlink-telegram route, and
 * returns no telegram fields on /admin/stats, /admin/config or /admin/users. Every Telegram
 * control in this SPA therefore either errored or showed a permanent "Not linked". Off unless
 * VITE_TELEGRAM_ENABLED=true at build time; the client calls and types stay in place so turning
 * it back on is just that env var once the API grows the endpoints.
 */
export const TELEGRAM_ENABLED = import.meta.env.VITE_TELEGRAM_ENABLED === "true";
