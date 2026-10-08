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
  constructor() { super(); bot = this; this.sent = []; }
  onText() {}
  async answerCallbackQuery() {
    throw new Error('ETELEGRAM: 400 Bad Request: query is too old and response timeout expired or query ID is invalid');
  }
  async sendMessage(chatId, text) { this.sent.push({ chatId, text }); return { message_id: 1, chat: { id: chatId } }; }
  async editMessageText() { return true; }
  async stopPolling() {}
}

const unhandled = [];
const onUnhandled = (r) => unhandled.push(r);
const realFetch = global.fetch;

before(() => {
  require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: FakeBot };
  global.fetch = async () => ({ ok: true, json: async () => ({ tokens: [] }) });
  process.on('unhandledRejection', onUnhandled);
  require('../telegram-bot').startBot('test-token');
});

after(() => {
  process.off('unhandledRejection', onUnhandled);
  global.fetch = realFetch;
  if (realLib) require.cache[libPath] = realLib; else delete require.cache[libPath];
});

const settle = () => new Promise(r => setTimeout(r, 50));

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
