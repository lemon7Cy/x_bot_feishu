import test from 'node:test';
import assert from 'node:assert/strict';
import { sendFeishu } from '../src/feishu.js';

test('sendFeishu retries transient Feishu internal errors', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      text: async () => (calls.length === 1
        ? JSON.stringify({ code: 19006, data: {}, msg: 'internal error' })
        : JSON.stringify({ code: 0, data: {}, msg: 'ok' }))
    };
  };
  try {
    await sendFeishu({ msg_type: 'interactive', card: {} }, {
      FEISHU_WEBHOOK_URL: 'https://example.test/webhook',
      FEISHU_RETRIES: '1',
      FEISHU_RETRY_DELAYS_MS: '0'
    });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendFeishu does not retry non-transient Feishu errors', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: true,
      text: async () => JSON.stringify({ code: 9499, data: {}, msg: 'bad request' })
    };
  };
  try {
    await assert.rejects(
      () => sendFeishu({ msg_type: 'interactive', card: {} }, {
        FEISHU_WEBHOOK_URL: 'https://example.test/webhook',
        FEISHU_RETRIES: '2',
        FEISHU_RETRY_DELAYS_MS: '0'
      }),
      /Feishu webhook error/
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
