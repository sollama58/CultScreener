const TelegramBot = require('node-telegram-bot-api');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

let bot = null;

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatNumber(num) {
  if (num === null || num === undefined) return 'N/A';
  if (num >= 1_000_000_000) return `$${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `$${(num / 1_000).toFixed(1)}K`;
  return `$${num.toFixed(2)}`;
}

function formatPrice(price) {
  if (price === null || price === undefined) return 'N/A';
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

async function fetchTopConvictionTokens(limit = 10) {
  const url = `${API_BASE_URL}/api/tokens/leaderboard/conviction?limit=${limit}&offset=0`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`API responded with status ${response.status}`);
  const data = await response.json();
  return data.tokens || [];
}

// ─── Message builders ─────────────────────────────────────────────────────────

function buildStartMessage(firstName) {
  const name = firstName ? ` ${e(firstName)}` : '';
  return [
    `👋 *Welcome${name} to CultScreener\\!*`,
    '',
    "CultScreener tracks *diamond hand conviction* on Solana — measuring what percentage of a token's holders have held for *1 month or longer*\\.",
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
    '🌐 Full terminal: [cultscreener\\.com](https://cultscreener.com)',
  ].join('\n');
}

function buildHelpMessage() {
  return [
    '📖 *CultScreener Bot Help*',
    '',
    '*What is conviction?*',
    'The % of sampled holders who have held a token for *1 month or longer*\\. Higher conviction = stronger diamond hands\\.',
    '',
    '*Commands*',
    '`/start` — introduction & overview',
    '`/TryConviction` — top 10 tokens by conviction score',
    '`/help` — show this message',
    '',
    '*On the leaderboard only curated tokens appear\\.* These are manually reviewed tokens added by the CultScreener team\\.',
    '',
    '🌐 [cultscreener\\.com](https://cultscreener.com)',
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
    const emoji = getConvictionEmoji(token.conviction1m);
    const label = getConvictionLabel(token.conviction1m);
    const name = e(token.name || token.symbol || 'Unknown');
    const symbol = token.symbol ? ` \\(${e(token.symbol)}\\)` : '';
    const conviction = token.conviction1m != null ? `${token.conviction1m.toFixed(1)}%` : 'N/A';
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

  lines.push(`_Updated live • [cultscreener\\.com](https://cultscreener.com)_`);
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

function startBot(token) {
  if (!token) {
    console.log('[TelegramBot] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log('[TelegramBot] Bot started');

  // /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const firstName = msg.from?.first_name;
    try {
      await bot.sendMessage(chatId, buildStartMessage(firstName), {
        ...MSG_OPTS,
        reply_markup: {
          inline_keyboard: [[
            { text: '📊 Top Conviction Tokens', callback_data: 'conviction' },
            { text: '🌐 Open Website', url: 'https://cultscreener.com' },
          ]],
        },
      });
    } catch (err) {
      console.error('[TelegramBot] /start error:', err.message);
    }
  });

  // /help
  bot.onText(/\/help/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      await bot.sendMessage(chatId, buildHelpMessage(), MSG_OPTS);
    } catch (err) {
      console.error('[TelegramBot] /help error:', err.message);
    }
  });

  // /TryConviction
  bot.onText(/\/TryConviction/i, async (msg) => {
    const chatId = msg.chat.id;

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
      console.error('[TelegramBot] /TryConviction error:', err.message);
      const errText = '❌ Failed to fetch conviction data\\. Please try again in a moment\\.';
      await sendOrEdit(chatId, errText, loadingMsg).catch(() =>
        bot.sendMessage(chatId, '❌ Failed to fetch conviction data. Please try again.')
      );
    }
  });

  // Inline button: "Top Conviction Tokens"
  bot.on('callback_query', async (query) => {
    if (query.data !== 'conviction') return;

    await bot.answerCallbackQuery(query.id, { text: 'Fetching conviction data...' });

    const chatId = query.message.chat.id;
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
      console.error('[TelegramBot] callback conviction error:', err.message);
      await sendOrEdit(chatId, '❌ Failed to fetch conviction data\\.', loadingMsg).catch(() => {});
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[TelegramBot] Polling error:', err.message);
  });
}

async function stopBot() {
  if (bot) {
    await bot.stopPolling();
    bot = null;
    console.log('[TelegramBot] Bot stopped');
  }
}

module.exports = { startBot, stopBot };
