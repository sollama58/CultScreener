/**
 * The callback_query listener must not leave a rejected promise behind: the worker exits on
 * any unhandledRejection. node-telegram-bot-api is stubbed; nothing reaches Telegram.
 * Lives under services/ because the npm test glob, expanded by sh without globstar, only
 * reaches test files one directory below src/.
 */
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');

const libPath = require.resolve('node-telegram-bot-api');
const realLib = require.cache[libPath];
let bot;

class FakeBot extends EventEmitter {
  constructor() {
    super(); bot = this; this.sent = []; this.texts = []; this.calls = []; this._polling = { options: { params: { offset: 0 } } };
  }
  onText(regexp, cb) { this.texts.push([regexp, cb]); }
  async getMe() { return { username: 'HolDEXBot' }; }
  async answerCallbackQuery() {
    throw new Error('ETELEGRAM: 400 Bad Request: query is too old and response timeout expired or query ID is invalid');
  }
  async sendMessage(chatId, text) { this.sent.push({ chatId, text }); return { message_id: 1, chat: { id: chatId } }; }
  async editMessageText(text, opts) { this.sent.push({ chatId: opts.chat_id, text, edit: true }); return true; }
  async stopPolling() { this.calls.push('stopPolling'); }
  async startPolling() { this.calls.push('startPolling'); }
  async getUpdates(params) { this.calls.push(['getUpdates', params]); return []; }
  // What processUpdate does for a text message: every matching onText callback runs
  receive(text, chatId = 7) {
    const msg = { chat: { id: chatId }, text };
    return Promise.all(this.texts.map(([re, cb]) => { const m = re.exec(text); return m ? cb(msg, m) : null; }));
  }
}

const unhandled = [];
const onUnhandled = (r) => unhandled.push(r);
const realFetch = global.fetch;
const fetches = [];
let fetchImpl = async () => ({ ok: true, json: async () => ({ tokens: [] }) });

const settle = (ms = 50) => new Promise(r => setTimeout(r, ms));

let telegramBot;
before(async () => {
  require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: FakeBot };
  global.fetch = async (url, opts) => { fetches.push({ url, opts }); return fetchImpl(url, opts); };
  process.on('unhandledRejection', onUnhandled);
  telegramBot = require('../telegram-bot');
  telegramBot.startBot('test-token');
  await settle();
});

after(() => {
  process.off('unhandledRejection', onUnhandled);
  global.fetch = realFetch;
  if (realLib) require.cache[libPath] = realLib; else delete require.cache[libPath];
});


describe('conviction button callback', () => {
  test('a stale callback whose answer is rejected still replies and leaves nothing unhandled', async () => {
    bot.emit('callback_query', { id: 'q1', data: 'conviction', message: { chat: { id: 42 } } });
    await settle();
    assert.deepStrictEqual(unhandled, []);
    assert.ok(bot.sent.some(m => m.chatId === 42), 'still sends the conviction message');
  });

  test('a callback with no message (inline mode) is ignored without throwing', async () => {
    bot.emit('callback_query', { id: 'q2', data: 'conviction', inline_message_id: 'x' });
    await settle();
    assert.deepStrictEqual(unhandled, []);
  });
});

describe('formatting (audit #118, #184)', () => {
  test('an unknown price or market cap (sent as 0) shows N/A, not $0.00e+0', () => {
    const { formatPrice, formatNumber } = telegramBot._internal;
    assert.strictEqual(formatPrice(0), 'N/A');
    assert.strictEqual(formatPrice(NaN), 'N/A');
    assert.strictEqual(formatPrice(0.0000001), '$1.00e-7');
    assert.strictEqual(formatNumber(0), 'N/A');
    assert.strictEqual(formatNumber(1500), '$1.5K');
  });

  test('a token with no sampled wallets is shown as not yet analyzed, not as 0.0% Low', () => {
    const msg = telegramBot._internal.buildConvictionMessage([
      { name: 'Measured', conviction1m: 62.5, sampleSize: 120, convictionUpdatedAt: '2026-10-01T00:00:00Z', price: 1, marketCap: 1e6 },
      { name: 'Fresh', conviction1m: 0, sampleSize: 0, convictionUpdatedAt: null, price: 0, marketCap: 0 },
    ]);
    assert.match(msg, /Measured.*_High_/);
    assert.match(msg, /Fresh.*Not yet analyzed/);
    assert.doesNotMatch(msg, /Fresh.*Low/);
    assert.match(msg, /Conviction: `N\/A`/);
  });
});

describe('commands (audit #120)', () => {
  test('only a command at the start of the message, for this bot, gets a reply', async () => {
    const before = bot.sent.length;
    await bot.receive('/helpdesk is down');
    await bot.receive('see https://example.com/start');
    await bot.receive('/help@SomeOtherBot');
    assert.strictEqual(bot.sent.length, before, 'none of these is a command for this bot');

    await bot.receive('/Help@HolDEXBot');
    await bot.receive('/start');
    assert.strictEqual(bot.sent.length, before + 2);
  });
});

describe('leaderboard requests (audit #119, #183, #184)', () => {
  test('a chat repeating /TryConviction within the cooldown gets one reply, and chats share a recent fetch', async () => {
    const fetchesBefore = fetches.length;
    await bot.receive('/TryConviction', 501);
    await bot.receive('/TryConviction', 501);
    await bot.receive('/tryconviction@HolDEXBot', 502);
    assert.strictEqual(bot.sent.filter(m => m.chatId === 501 && !m.edit).length, 1, 'one placeholder for chat 501');
    assert.ok(bot.sent.some(m => m.chatId === 502), 'another chat is not held back');
    assert.ok(fetches.length - fetchesBefore <= 1, 'the leaderboard is fetched at most once');
  });

  test('the fetch has a timeout and asks for a minimum sample', async () => {
    const { url, opts } = fetches[fetches.length - 1];
    assert.match(url, /minSample=\d+/);
    assert.ok(opts && opts.signal, 'fetch carries an abort signal');
  });

  test('cooldown expires', () => {
    const { onCooldown, CHAT_COOLDOWN_MS } = telegramBot._internal;
    assert.strictEqual(onCooldown(900, 1000), false);
    assert.strictEqual(onCooldown(900, 1000 + CHAT_COOLDOWN_MS - 1), true);
    assert.strictEqual(onCooldown(900, 1000 + CHAT_COOLDOWN_MS), false);
  });
});

describe('polling errors (audit #121)', () => {
  test('a transient error pauses polling and restarts it after a backoff', async () => {
    bot.calls.length = 0;
    bot.emit('polling_error', Object.assign(new Error('EFATAL: socket hang up'), {}));
    await settle(20);
    assert.deepStrictEqual(bot.calls, ['stopPolling'], 'stopped, not retried at once');
    await settle(1100);
    assert.deepStrictEqual(bot.calls, ['stopPolling', 'startPolling']);
  });

  test('a rejected token stops polling for good', async () => {
    bot.calls.length = 0;
    bot.emit('polling_error', Object.assign(new Error('ETELEGRAM: 401 Unauthorized'), { response: { statusCode: 401 } }));
    await settle(1200);
    assert.deepStrictEqual(bot.calls, ['stopPolling']);
  });
});

describe('shutdown (audit #122)', () => {
  test('stopBot confirms the last offset and lets a dispatched command finish its reply', async () => {
    let release;
    fetchImpl = () => new Promise(r => { release = () => r({ ok: true, json: async () => ({ tokens: [] }) }); });
    // Past the cached leaderboard, so this command really waits on the fetch
    const realNow = Date.now;
    Date.now = () => realNow() + 120000;
    try {
      bot.receive('/TryConviction', 777);
      await settle(20);
      const b = bot;
      b._polling.options.params.offset = 1234;
      b.calls.length = 0;
      const stopped = telegramBot.stopBot();
      await settle(20);
      assert.deepStrictEqual(b.calls, ['stopPolling', ['getUpdates', { offset: 1234, limit: 1, timeout: 0 }]]);
      assert.ok(!b.sent.some(m => m.chatId === 777 && m.edit), 'the reply is still pending');
      release();
      await stopped;
      assert.ok(b.sent.some(m => m.chatId === 777 && m.edit), 'the reply was sent before stopBot returned');
    } finally {
      Date.now = realNow;
    }
  });
});
