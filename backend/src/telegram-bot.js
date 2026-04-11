const TelegramBot = require('node-telegram-bot-api');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

let bot = null;

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

function getConvictionEmoji(conviction) {
  if (conviction >= 75) return '💎';
  if (conviction >= 50) return '🔥';
  if (conviction >= 25) return '📈';
  return '👀';
}

// Escape special MarkdownV2 characters
function escapeMd(text) {
  if (text === null || text === undefined) return 'N/A';
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

async function fetchTopConvictionTokens(limit = 10) {
  const url = `${API_BASE_URL}/api/tokens/leaderboard/conviction?limit=${limit}&offset=0`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`API responded with status ${response.status}`);
  }
  const data = await response.json();
  return data.tokens || [];
}

function buildConvictionMessage(tokens) {
  if (!tokens.length) {
    return '⚠️ No conviction data available right now\\. Try again shortly\\.';
  }

  const lines = [
    '💎 *Top 10 Tokens by Conviction*',
    '_% of holders holding 1m\\+_',
    '',
  ];

  tokens.slice(0, 10).forEach((token, i) => {
    const rank = i + 1;
    const emoji = getConvictionEmoji(token.conviction1m);
    const name = escapeMd(token.name || token.symbol || 'Unknown');
    const symbol = token.symbol ? escapeMd(`$${token.symbol}`) : '';
    const conviction = token.conviction1m != null ? `${token.conviction1m.toFixed(1)}%` : 'N/A';
    const mcap = escapeMd(formatNumber(token.marketCap));
    const price = escapeMd(formatPrice(token.price));
    const holders = token.sampleSize != null ? ` · ${escapeMd(`${token.sampleSize} sampled`)}` : '';

    lines.push(
      `${rank}\\. ${emoji} *${name}* ${symbol}`,
      `   Conviction: \`${conviction}\` · MCap: \`${mcap}\``,
      `   Price: \`${price}\`${holders}`,
      ''
    );
  });

  lines.push('_Powered by [CultScreener](https://cultscreener\\.com)_');
  return lines.join('\n');
}

function startBot(token) {
  if (!token) {
    console.log('[TelegramBot] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log('[TelegramBot] Bot started');

  bot.onText(/\/TryConviction/i, async (msg) => {
    const chatId = msg.chat.id;

    let loadingMsg;
    try {
      loadingMsg = await bot.sendMessage(chatId, '🔍 Fetching top conviction tokens...');
    } catch {
      // continue without loading message
    }

    try {
      const tokens = await fetchTopConvictionTokens(10);
      const message = buildConvictionMessage(tokens);

      if (loadingMsg) {
        await bot.editMessageText(message, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        });
      } else {
        await bot.sendMessage(chatId, message, {
          parse_mode: 'MarkdownV2',
          disable_web_page_preview: true,
        });
      }
    } catch (err) {
      console.error('[TelegramBot] Error handling /TryConviction:', err.message);
      const errText = '❌ Failed to fetch conviction data\\. Please try again in a moment\\.';
      if (loadingMsg) {
        await bot.editMessageText(errText, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
          parse_mode: 'MarkdownV2',
        }).catch(() => bot.sendMessage(chatId, '❌ Failed to fetch conviction data. Please try again.'));
      } else {
        await bot.sendMessage(chatId, '❌ Failed to fetch conviction data. Please try again.').catch(() => {});
      }
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
