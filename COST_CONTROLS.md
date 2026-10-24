# Review cost controls

The production app is hosted as a DirectAdmin Node.js app. Upload changed runtime files to its application root, restart that Node.js app, and refresh the browser. Keep the existing database location and encryption secret during updates.

Character sheet generation also needs `public/images/character-sheet-layout-reference.png` in that relative path on the server. The app sends it as a Seedream reference image with each character sheet request; include it when uploading the character-sheet changes.

For local development, run this app directly with Node.js 24 or newer. DeepSeek Harness is not required:

```powershell
npm start
```

Open the URL printed by the server. Stop and restart an existing app process after updating these files, then refresh the browser. Choose the Reviewer provider and model in Settings. The app's existing model defaults have not been changed.

## Focused coding tasks

Use GitHub branches and pull requests as the source of truth. Assign one bounded task per chat, use a separate worktree for each parallel task, and coordinate edits to shared files. Keep handoffs short: task, files changed, tests, and remaining issues. Separate chats keep unrelated history apart, but additional agents can increase total token usage; GitHub itself does not limit model context or spending.

## Review behavior

- **Review** reuses persisted results when the field content, relevant sources, reviewer instructions, criteria, provider, endpoint, and model are unchanged. Cache hits make no upstream request.
- **Review again** explicitly refreshes the section, including unchanged fields. This makes new API calls.
- New or changed fields share a batch, up to eight fields and 40,000 characters of field text. Larger sections use multiple batches.
- Empty fields fail locally. Fields above 16,000 characters must be shortened or split rather than silently reviewing a truncated field.
- Context uses reference excerpts, short continuity summaries, and the scene outline. It excludes the dump of other generation prompts and full unrelated character bibles. Full relevant source data is still hashed locally so edits beyond an excerpt invalidate the cache.
- A valid negative review is saved. Invalid JSON, missing or duplicate field results, unclear verdicts, and provider failures are not saved as completed reviews. There are no automatic paid retries.
- Simultaneous requests for the same section snapshot share one upstream operation within a server process. Use one Node app process for this protection; multiple independent workers do not share the in-memory request lock.
- Results belong to the signed-in user and project. They survive app restarts. Existing content-only cache entries cannot match the new fingerprints, so the first review after this upgrade runs again.

## Usage records

Chat and field-review upstream calls write to the `api_usage` table in the app's SQLite database (`data/app.db` unless configured otherwise). Records include operation, provider, model, status, duration, and provider-reported input/output/cached token counts. API keys, prompts, reference text, response text, and request headers are not stored in telemetry.

Input totals already include cached tokens: do not add cached input to total input again. Missing counters remain SQL `NULL`. A successful upstream call can still return an invalid review, so an API success record is not an approval or proof of a valid review. Other generation endpoints are outside this chat/review log.

For example, run this query with a SQLite viewer against the configured database:

```sql
SELECT operation, model, COUNT(*) AS requests,
       SUM(input_tokens) AS input_tokens,
       SUM(cached_input_tokens) AS cached_input_tokens,
       SUM(output_tokens) AS output_tokens,
       SUM(CASE WHEN total_tokens IS NULL THEN 1 ELSE 0 END) AS requests_without_token_totals
FROM api_usage
GROUP BY operation, model;
```

## Verification

`npm test` uses temporary databases and local mock APIs. It does not require real API keys or make paid model requests. Reviewer checks cover caching across restart, changed content/context/model, concurrent requests, forced review, malformed responses, and batch limits.
