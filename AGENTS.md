# Working in Carnival

This is a Node.js application deployed through a DirectAdmin Node.js app. Use Node 24 or newer. The app uses built-in modules, including `node:sqlite`; it has no npm dependencies.

## Code map

- `server.js`: HTTP routes, provider requests, generation, reviewer batching, and cache fingerprints.
- `fieldreviews.js`: persisted field-review results. `apiusage.js`: chat/review usage counters.
- `db.js`, `story.js`, `assets.js`, `reviews.js`: application storage and domain logic.
- `public/app.js`, `public/index.html`, `public/styles.css`: browser UI. Keep the existing plain JavaScript architecture.
- `public/app.js` `MODULES`: the module registry. Carnival is the umbrella, and every screen belongs to a module (`story-studio`, `generate-images`) or to the shared services (`SHARED_TOOLS`: Ideas, Library, Settings, Docs). A module declares its screens, the `switchTab` panel key each screen activates, its workflow step (Story Studio), its `guide` text for the assistant, and whether it carries a story context. Adding a module means adding one registry entry plus the panels it points at — the navigation, the story selector, and the progress overview need no changes. `SHARED_TOOLS` render into the app header (`#header-shared`), preceded by Generate. Generate restores the active module screen and reveals the module row and workflow controls; shared services hide those controls.
- `GET /api/studio/:projectId/progress`: the Story Studio overview. Each step's status is derived from the data that step edits, so it cannot drift from the work. `attention` must always mean a human decision is waiting, never work that is merely unfinished; `done`/`todo` cover the rest.
- Bump `?v=` on `styles.css` and `app.js` in `public/index.html` whenever either file changes, or a browser can keep running a stale bundle after a deploy.
- `test/`: tests with local mock providers and temporary databases.

## Keep agent work focused

- Give each chat one bounded task with acceptance criteria. Read current repository files rather than relying on another chat's history.
- For work assigned to multiple agents, use a separate branch and Git worktree for each task. Coordinate file ownership before parallel edits, especially `server.js` and `public/app.js`.
- Read narrow file ranges and summarize findings with file paths. Avoid repeatedly pasting full files, project records, logs, or previous conversations into prompts.
- Save durable decisions in short repository notes when they help the next task. GitHub stores source and diffs; it does not cap model context or token usage.

## Validation and deployment

- Use `npm test` for the full suite. Run focused tests during development, such as `node test/reviewer-bot.test.js` or `node test/generation-prompts.test.js`.
- Tests use local mocks. Do not call live paid providers for verification unless the user explicitly requests it. Use temporary databases and synthetic keys.
- Preserve user/project isolation, cached-review invalidation, separate human approval, and existing saved prompts on provider failures.
- Never commit `.env`, API keys, `data/`, database files, image uploads, or logs.
- Submit tested changes in a branch and pull request. Preserve unrelated changes and deployment files, including `public/.htaccess`.
- Production deployment is separate: upload changed runtime files to the DirectAdmin app root, restart that Node.js app, and refresh the browser. Keep the configured database location and encryption secret during updates.
