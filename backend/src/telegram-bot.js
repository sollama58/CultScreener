const TelegramBot = require('node-telegram-bot-api');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

let bot = null;
// The bot's @username (from getMe), so commands addressed to other bots are ignored
let botUsername = null;

// A stalled API response must not leave the 'Fetching...' placeholder up for minutes
const FETCH_TIMEOUT_MS = 10 * 1000;
// Every command fetches through the public API's per-IP rate limit, which all chats
// share (the worker has one egress IP): reuse a recent leaderboard instead of refetching
const LEADERBOARD_CACHE_MS = 60 * 1000;
// One conviction request per chat this often; extra commands and taps are ignored
const CHAT_COOLDOWN_MS = 10 * 1000;
// Tokens whose conviction comes from fewer sampled wallets than this are left out
const MIN_SAMPLE = 10;

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatNumber(num) {
  // The leaderboard sends 0 for an unknown market cap
  if (num === null || num === undefined || !Number.isFinite(num) || num <= 0) return 'N/A';
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function formatPrice(price) {
  // The leaderboard sends 0 for an unknown price
  if (price === null || price === undefined || !Number.isFinite(price) || price <= 0) return 'N/A';
  if (price < 0.000001) return `$${price.toExponential(2)}`;
  if (price < 0.01) return `$${price.toFixed(6)}`;
  if (price < 1) return `$${price.toFixed(4)}`;
  return `$${price.toFixed(2)}`;
}

function formatChange(pct) {
  if (pct === null || pct === undefined) return null;
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function getConvictionEmoji(conviction) {
  if (conviction >= 75) return '💎';
  if (conviction >= 50) return '🔥';
  if (conviction >= 25) return '📈';
  return '👀';
}

function getConvictionLabel(conviction) {
  if (conviction >= 75) return 'Elite';
  if (conviction >= 50) return 'High';
  if (conviction >= 25) return 'Mid';
  return 'Low';
}

// Escape special MarkdownV2 characters
function e(text) {
  if (text === null || text === undefined) return 'N/A';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

// ─── API ─────────────────────────────────────────────────────────────────────

const leaderboardCache = new Map(); // limit -> { at, tokens }
const leaderboardInFlight = new Map(); // limit -> Promise

async function fetchTopConvictionTokens(limit = 10) {
  const cached = leaderboardCache.get(limit);
  if (cached && Date.now() - cached.at < LEADERBOARD_CACHE_MS) return cached.tokens;
  // Requests arriving together share one fetch
  if (leaderboardInFlight.has(limit)) return leaderboardInFlight.get(limit);
  const request = (async () => {
    const url = `${API_BASE_URL}/api/tokens/leaderboard/conviction?limit=${limit}&offset=0&minSample=${MIN_SAMPLE}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`API responded with status ${response.status}`);
    const data = await response.json();
    const tokens = data.tokens || [];
    leaderboardCache.set(limit, { at: Date.now(), tokens });
    return tokens;
  })().finally(() => leaderboardInFlight.delete(limit));
  leaderboardInFlight.set(limit, request);
  return request;
}

// chatId -> when it last asked for the leaderboard
const lastConvictionRequest = new Map();

/** True when this chat asked within CHAT_COOLDOWN_MS; otherwise records the request. */
function onCooldown(chatId, now = Date.now()) {
  const last = lastConvictionRequest.get(chatId);
  if (last && now - last < CHAT_COOLDOWN_MS) return true;
  if (lastConvictionRequest.size > 5000) {
    for (const [id, at] of lastConvictionRequest) if (now - at >= CHAT_COOLDOWN_MS) lastConvictionRequest.delete(id);
  }
  lastConvictionRequest.set(chatId, now);
  return false;
}

/**
 * A command at the start of the message, optionally addressed with @username.
 * Group 1 is the username it was addressed to, if any.
 */
function commandPattern(name) {
  return new RegExp(`^/${name}(?:@(\\w+))?(?=\\s|$)`, 'i');
}

/** False for a command addressed to a different bot (/help@OtherBot). */
function addressedToBot(match) {
  const target = match && match[1];
  return !target || !botUsername || target.toLowerCase() === botUsername.toLowerCase();
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildStartMessage(firstName) {
  const name = firstName ? ` ${e(firstName)}` : '';
  return [
    `👋 *Welcome${name} to HolDEX\\!*`,
    '',
    "HolDEX tracks *diamond hand conviction* on Solana — measuring what percentage of a token's holders have held for *1 month or longer*\\.",
    '',
    '📊 *Conviction Tiers*',
    '💎 *Elite* — 75%\\+ of holders holding 1m\\+',
    '🔥 *High* — 50%\\+ of holders holding 1m\\+',
    '📈 *Mid* — 25%\\+ of holders holding 1m\\+',
    '👀 *Low* — under 25% holding 1m\\+',
    '',
    '🤖 *Commands*',
    '/TryConviction — top 10 tokens by conviction',
    '/help — show this help again',
    '',
    '🌐 Full terminal: [holdex\\.live](https://holdex.live)',
  ].join('\n');
}

function buildHelpMessage() {
  return [
    '📖 *HolDEX Bot Help*',
    '',
    '*What is conviction?*',
    'The % of sampled holders who have held a token for *1 month or longer*\\. Higher conviction = stronger diamond hands\\.',
    '',
    '*Commands*',
    '`/start` — introduction & overview',
    '`/TryConviction` — top 10 tokens by conviction score',
    '`/help` — show this message',
    '',
    '*On the leaderboard only curated tokens appear\\.* These are manually reviewed tokens added by the HolDEX team\\.',
    '',
    '🌐 [holdex\\.live](https://holdex.live)',
  ].join('\n');
}

function buildConvictionMessage(tokens) {
  if (!tokens.length) {
    return '⚠️ No conviction data available right now\\. Try again shortly\\.';
  }

  const lines = [
    '💎 *Top 10 Tokens by Conviction*',
    `_Ranked by % of holders holding 1m\\+_`,
    '',
  ];

  tokens.slice(0, 10).forEach((token, i) => {
    const rank = i + 1;
    // A token with no sampled wallets has not been analyzed yet; its 0 is not a measurement
    const analyzed = token.conviction1m != null && token.sampleSize > 0 && !!token.convictionUpdatedAt;
    const emoji = analyzed ? getConvictionEmoji(token.conviction1m) : '⏳';
    const label = analyzed ? getConvictionLabel(token.conviction1m) : 'Not yet analyzed';
    const name = e(token.name || token.symbol || 'Unknown');
    const symbol = token.symbol ? ` \\(${e(token.symbol)}\\)` : '';
    const conviction = analyzed ? `${token.conviction1m.toFixed(1)}%` : 'N/A';
    const mcap = e(formatNumber(token.marketCap));
    const price = e(formatPrice(token.price));
    const change = formatChange(token.priceChange24h);
    const changePart = change ? ` ${e(change)}` : '';

    lines.push(
      `*${rank}\\.* ${emoji} *${name}*${symbol} — _${e(label)}_`,
      `   📊 Conviction: \`${conviction}\`  💰 MCap: \`${mcap}\``,
      `   💵 Price: \`${price}\`${changePart}`,
      ''
    );
  });

  lines.push(`_Updated live • [holdex\\.live](https://holdex.live)_`);
  return lines.join('\n');
}

// ─── Command helpers ──────────────────────────────────────────────────────────

const MSG_OPTS = {
  parse_mode: 'MarkdownV2',
  disable_web_page_preview: true,
};

async function sendOrEdit(chatId, text, loadingMsg) {
  if (loadingMsg) {
    return bot.editMessageText(text, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      ...MSG_OPTS,
    });
  }
  return bot.sendMessage(chatId, text, MSG_OPTS);
}

// ─── Bot lifecycle ────────────────────────────────────────────────────────────

// Polling retries after an error wait this long, doubling while errors keep coming
const POLL_BACKOFF_MIN_MS = 1000;
const POLL_BACKOFF_MAX_MS = 5 * 60 * 1000;
// Polling this long without an error after a wait resets the backoff
const POLL_QUIET_RESET_MS = 60 * 1000;
// On shutdown, how long already-dispatched commands get to send their reply
const HANDLER_DRAIN_MS = 15 * 1000;

let pollBackoffMs = 0;
let lastPollErrorAt = 0;
let pollRestartTimer = null;
let stopping = false;
// Command handlers still running, so shutdown can let them finish their reply
const inFlightHandlers = new Set();

function tracked(handler) {
  return (...args) => {
    const p = Promise.resolve().then(() => handler(...args)).catch((err) => {
      console.error('[TelegramBot] Handler error:', err.message);
    });
    inFlightHandlers.add(p);
    p.finally(() => inFlightHandlers.delete(p));
    return p;
  };
}

/**
 * The library re-polls 300 ms after any error, forever. A rejected token (401/404)
 * stops the bot; anything else (Telegram unreachable, 409 while another instance
 * polls) waits with exponential backoff, logging one line per retry.
 */
function onPollingError(err) {
  const current = bot;
  if (!current || stopping) return;
  const status = err?.response?.statusCode;
  if (status === 401 || status === 404) {
    console.error(`[TelegramBot] Telegram rejected the bot token (${err.message}); polling stopped. Check TELEGRAM_BOT_TOKEN.`);
    current.stopPolling().catch(() => {});
    return;
  }
  const now = Date.now();
  const quiet = !lastPollErrorAt || now - lastPollErrorAt > pollBackoffMs + POLL_QUIET_RESET_MS;
  pollBackoffMs = quiet ? POLL_BACKOFF_MIN_MS : Math.min(pollBackoffMs * 2, POLL_BACKOFF_MAX_MS);
  lastPollErrorAt = now;
  if (pollRestartTimer) return;
  console.error(`[TelegramBot] Polling error: ${err.message} (retrying in ${Math.round(pollBackoffMs / 1000)}s)`);
  const wait = pollBackoffMs;
  // stopPolling without cancel: with cancel the library schedules the next poll anyway
  current.stopPolling().catch(() => {}).then(() => {
    if (bot !== current || stopping) return;
    pollRestartTimer = setTimeout(() => {
      pollRestartTimer = null;
      if (bot === current && !stopping) Promise.resolve().then(() => current.startPolling()).catch(() => {});
    }, wait);
  });
}

async function replyWithConviction(chatId, errText) {
  let loadingMsg;
  try {
    loadingMsg = await bot.sendMessage(chatId, '🔍 Fetching top conviction tokens\\.\\.\\.',  MSG_OPTS);
  } catch {
    // continue without loading message
  }

  try {
    const tokens = await fetchTopConvictionTokens(10);
    const message = buildConvictionMessage(tokens);
    await sendOrEdit(chatId, message, loadingMsg);
  } catch (err) {
    console.error('[TelegramBot] conviction error:', err.message);
    await sendOrEdit(chatId, errText, loadingMsg).catch(() =>
      bot.sendMessage(chatId, '❌ Failed to fetch conviction data. Please try again.').catch(() => {})
    );
  }
}

function startBot(token) {
  if (!token) {
    console.log('[TelegramBot] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  stopping = false;
  console.log('[TelegramBot] Bot started');
  const current = bot;
  Promise.resolve().then(() => current.getMe()).then((me) => { botUsername = me?.username || null; }).catch(() => {});

  // /start
  bot.onText(commandPattern('start'), tracked(async (msg, match) => {
    if (!addressedToBot(match)) return;
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name;
    try {
      await bot.sendMessage(chatId, buildStartMessage(firstName), {
        ...MSG_OPTS,
        reply_markup: {
          inline_keyboard: [[
            { text: '📊 Top Conviction Tokens', callback_data: 'conviction' },
            { text: '🌐 Open Website', url: 'https://holdex.live' },
          ]],
        },
      });
    } catch (err) {
      console.error('[TelegramBot] /start error:', err.message);
    }
  }));

  // /help
  bot.onText(commandPattern('help'), tracked(async (msg, match) => {
    if (!addressedToBot(match)) return;
    const chatId = msg.chat.id;
    try {
      await bot.sendMessage(chatId, buildHelpMessage(), MSG_OPTS);
    } catch (err) {
      console.error('[TelegramBot] /help error:', err.message);
    }
  }));

  // /TryConviction
  bot.onText(commandPattern('TryConviction'), tracked(async (msg, match) => {
    if (!addressedToBot(match)) return;
    const chatId = msg.chat.id;
    if (onCooldown(chatId)) return;
    await replyWithConviction(chatId, '❌ Failed to fetch conviction data\\. Please try again in a moment\\.');
  }));

  // Inline button: "Top Conviction Tokens"
  bot.on('callback_query', tracked(async (query) => {
    if (query.data !== 'conviction') return;

    // Callbacks from inline-mode messages carry no message/chat to reply into
    const chatId = query.message?.chat?.id;
    const cooling = chatId !== undefined && chatId !== null && onCooldown(chatId);

    // Telegram rejects late answers (e.g. a tap queued while the worker was down); a
    // rejection here would be unhandled and take the worker process down with it.
    await bot.answerCallbackQuery(query.id, { text: cooling ? 'Just sent, give it a few seconds' : 'Fetching conviction data...' }).catch((err) => {
      console.warn('[TelegramBot] answerCallbackQuery failed:', err.message);
    });

    if (chatId === undefined || chatId === null || cooling) return;
    await replyWithConviction(chatId, '❌ Failed to fetch conviction data\\.');
  }));

  bot.on('polling_error', onPollingError);
}

/**
 * Stop polling, tell Telegram the last batch was received, and give the commands
 * it dispatched time to reply. Without the confirmation Telegram only learns of
 * the new offset from the next getUpdates, which never comes, so the next worker
 * would answer the same messages again.
 */
async function stopBot({ drainMs = HANDLER_DRAIN_MS } = {}) {
  const current = bot;
  if (!current) return;
  stopping = true;
  if (pollRestartTimer) { clearTimeout(pollRestartTimer); pollRestartTimer = null; }
  await current.stopPolling().catch(() => {});
  const offset = current._polling?.options?.params?.offset;
  if (offset && typeof current.getUpdates === 'function') {
    await current.getUpdates({ offset, limit: 1, timeout: 0 }).catch(() => {});
  }
  if (inFlightHandlers.size > 0) {
    let timer;
    await Promise.race([
      Promise.allSettled([...inFlightHandlers]),
      new Promise(r => { timer = setTimeout(r, drainMs); }),
    ]);
    clearTimeout(timer);
  }
  if (bot === current) bot = null;
  stopping = false;
  console.log('[TelegramBot] Bot stopped');
}

module.exports = {
  startBot,
  stopBot,
  // exported for tests
  _internal: { formatPrice, formatNumber, buildConvictionMessage, commandPattern, onCooldown, fetchTopConvictionTokens, onPollingError, CHAT_COOLDOWN_MS },
};
