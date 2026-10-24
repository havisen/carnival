'use strict';

const crypto = require('crypto');

// Input totals include cached tokens. Missing provider counters stay null.
function normalizeUsage(usage, provider) {
  if (!usage || typeof usage !== 'object') return null;
  const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
  let input = count(usage.prompt_tokens ?? usage.input_tokens);
  const output = count(usage.completion_tokens ?? usage.output_tokens);
  const cached = count(usage.prompt_cache_hit_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens);
  const written = count(usage.cache_creation_input_tokens);
  if (provider === 'anthropic' && input !== null) input += (cached || 0) + (written || 0);
  const total = count(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null);
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached, cacheWriteTokens: written, totalTokens: total };
}

function init(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_usage (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT,
      operation TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      status TEXT NOT NULL,
      error_code TEXT,
      duration_ms INTEGER NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cached_input_tokens INTEGER,
      cache_write_tokens INTEGER,
      total_tokens INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_user_time ON api_usage(user_id, created_at);
  `);
  const insert = database.prepare(`
    INSERT INTO api_usage (id, user_id, project_id, operation, provider, model, status,
      error_code, duration_ms, input_tokens, output_tokens, cached_input_tokens,
      cache_write_tokens, total_tokens, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return {
    record({ userId, projectId, operation, provider, model, status, errorCode, durationMs, usage }) {
      if (!userId) return;
      try {
        insert.run(crypto.randomUUID(), userId, projectId || null, operation, provider, model,
          status, errorCode || null, durationMs, usage?.inputTokens ?? null,
          usage?.outputTokens ?? null, usage?.cachedInputTokens ?? null,
          usage?.cacheWriteTokens ?? null, usage?.totalTokens ?? null, new Date().toISOString());
      } catch (_) {
        // A telemetry failure must not repeat an already billed request.
        console.warn('Could not save API usage.');
      }
    },
  };
}

module.exports = { init, normalizeUsage };
