'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { init, normalizeUsage } = require('../apiusage');

test('usage counts cached input once and preserves unavailable counters', () => {
  assert.equal(normalizeUsage(undefined, 'deepseek'), null);
  assert.deepEqual(normalizeUsage({
    prompt_tokens: 1000, prompt_cache_hit_tokens: 900, completion_tokens: 40, total_tokens: 1040,
  }, 'deepseek'), {
    inputTokens: 1000, outputTokens: 40, cachedInputTokens: 900, cacheWriteTokens: null, totalTokens: 1040,
  });
  assert.deepEqual(normalizeUsage({
    input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 40,
  }, 'anthropic'), {
    inputTokens: 1050, outputTokens: 40, cachedInputTokens: 900, cacheWriteTokens: 50, totalTokens: 1090,
  });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }, 'openai'), {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: null, cacheWriteTokens: null, totalTokens: 0,
  });
  assert.deepEqual(normalizeUsage({ output_tokens: 12 }, 'anthropic'), {
    inputTokens: null, outputTokens: 12, cachedInputTokens: null, cacheWriteTokens: null, totalTokens: null,
  });
});

test('usage records contain metadata and counters without request secrets', () => {
  const database = new DatabaseSync(':memory:');
  database.exec('CREATE TABLE users (id TEXT PRIMARY KEY); INSERT INTO users VALUES (\'user-one\')');
  const store = init(database);
  store.record({ userId: 'user-one', operation: 'field-review', provider: 'deepseek', model: 'test',
    status: 'error', errorCode: 'UPSTREAM_TIMEOUT', durationMs: 23,
    apiKey: 'must-not-be-stored', prompt: 'private prompt' });
  const row = database.prepare('SELECT * FROM api_usage').get();
  assert.equal(row.status, 'error');
  assert.equal(row.error_code, 'UPSTREAM_TIMEOUT');
  assert.equal(row.duration_ms, 23);
  assert.equal(row.total_tokens, null);
  assert.doesNotMatch(JSON.stringify(row), /must-not-be-stored|private prompt/);
  store.record({ operation: 'field-review' });
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM api_usage').get().count, 1);
  database.close();
});
