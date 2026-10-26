# Carnival

Development changes are reviewed in GitHub branches and pull requests. See
[AGENTS.md](AGENTS.md) for the code map and guidance for focused parallel work,
and [COST_CONTROLS.md](COST_CONTROLS.md) for reviewer caching and usage verification.
GitHub Actions runs the mock-provider test suite on pull requests and `main`.

Run the app locally with **Node 24 or newer** and `npm start`. After updating
runtime files, restart the app and refresh the browser. Preserve the database
and encryption secret.

A self-contained web app organized as **modules under the Carnival umbrella**. One
Node application and one database hold everything; each module owns its screens,
its navigation, its wording, and its assistant guidance.

**Story Studio** — one story at a time, through the whole workflow:

1. **🗂️ Projects** — every story you are working on.
2. **💡 Idea** — the idea and the brief of the current story.
3. **📚 References** — the shared reference material every image prompt is built from.
4. **🧑‍🎨 Characters & Locations** — the cast, the places, the look, and the character sheets.
5. **🎬 Scenes** — the scene outline, the action references, and continuity.
6. **🖼️ Generate** — one image prompt per action reference, then the images.
7. **✅ Review** — everything still waiting for a human decision.

**Generate Images** — character art with or without a story:

1. **🧑‍🎨 Character Maker** — reusable characters, saved for every story.
2. **🖼 Standalone Images** — prompt to image, with no project.

The header **📚 Generate** button opens Story Studio and Generate Images, with the
workflow controls below. Shared services hide those controls; Generate brings back
the last module screen, its selected view, and the current story.

**Shared services** serve every module and sit in the app header, beside your
account: **💡 Ideas** (create stories), the **🖼️ Library**, **🔑 Settings**, and
**📖 Docs**. Accounts, sessions, provider keys, usage tracking, model preferences,
and projects are shared. The browser never receives the stored keys: generation
runs on the server with the keys belonging to the signed-in user.

The **Current story** selector in the Story Studio bar is one choice that drives
every story screen, and the progress pill beside it summarises the story: how many
of the six steps are done, how many are waiting for a decision, and the next
action. Clicking it opens the full overview, where every step lists what is
finished, what needs approval, and what to do next. Progress is always derived
from the work itself — a step reports `attention` only when a person has to make a
decision, never for work that simply has not been done yet — so nothing can drift
from the underlying records.

Screens that earlier versions listed as top-level tabs now live here:

| Earlier name | Now |
| --- | --- |
| Idea Generator | Shared service **💡 Ideas** |
| Project Management | **Story Studio ▸ Projects** |
| Reference Stage | **Story Studio ▸ References** |
| Story Workspace | **Story Studio ▸ Idea / Characters & Locations / Scenes** (one screen per step) |
| Generation Stage | **Story Studio ▸ Generate** (prompt review moved to **▸ Review**) |
| Character maker | **Generate Images ▸ Character Maker** |
| Project characters | **Story Studio ▸ Characters & Locations ▸ Character images** |
| Standalone images | **Generate Images ▸ Standalone Images** (the header **Generate** button opens the modules) |
| Library, Settings, Docs | Shared services **🖼️ Library**, **🔑 Settings**, **📖 Docs** |

## Requirements

- **Node.js 24 or newer** for the built-in
  `node:sqlite` module. There are no npm dependencies.
- A modern browser.
- Optional: a **BytePlus ModelArk API key** for Seedream 5.0 Pro / 4.5 scene images.

## Run

```bash
npm start
# or
node server.js
```

Then open **http://localhost:3000**.

## Debugging generations with Track

Open **http://localhost:3000/track/** or click **Track** in the app header.
The page uses your existing Carnival sign-in and updates every two seconds.

- Browse incoming app API requests and outgoing DeepSeek, OpenAI-compatible,
  Anthropic, BytePlus, and generated-image download requests, including failures.
- Inspect prompts, raw provider replies (including reasoning, finish reasons, and
  token usage when supplied), final app responses, headers, status codes, request
  and response sizes, elapsed time, time to response headers, and network errors.
- Search payloads, models, project IDs, URLs, and errors; filter by direction and
  status; browse older pages; pause updates; or export a selected request as JSON.
- Select **Show all calls in this generation** to correlate a browser request
  with its provider calls. App responses also include an `X-Trace-Id` header.

Tracing starts with this update; earlier request payloads cannot be recovered.
History persists in the `request_traces` table of your existing SQLite database
and is isolated by account. Pending records become **interrupted** after a restart.
Tracker polling is excluded. Anonymous requests without an authenticated account
are not retained; successful sign-ins and registrations are recorded.

Passwords, API keys, cookies, authorization values, and signed URL credentials
are redacted. Image bytes are omitted, and captured payloads are limited to
256K characters per body (large app responses above 2 MiB are omitted).
Prompts and provider output are retained for debugging, so history grows with use
and should be treated as part of your local project data. Network details are
application-level timings and headers, not a packet capture or DNS/TLS breakdown.

## Validation

Run the automated Library/API checks with:

```bash
npm test
```

The test suite uses only Node's built-in `node:test` runner and does not add a
runtime dependency.

On first start the app creates `data/app.db` (SQLite) and, if `APP_SECRET` is
not set, `data/secret.key`.

To use a different port:

```bash
# Windows (PowerShell)
$env:PORT=8080; node server.js
```

## First use

1. Open the app and choose **Create account**.
2. Sign in, open **AI APIs**, paste your **DeepSeek API key**, and click
   **Save key**. It is encrypted and stored with your account.
3. Add context and click **✨ Generate ideas**. The idea prompt ends with
   `Describe Characters and Setting.` so generated descriptions include usable
   character and setting material.
4. Send selected ideas to **Project Management**. Projects are saved per user in
   the database, not in `localStorage`.
5. For scene images, save a **BytePlus ModelArk API key** in **AI APIs**. Seedream
   5.0 Pro is the only configured image model (1K, 1.5K, or 2K).
6. DeepSeek 4 Pro (`deepseek-v4-pro`) is the only configured text model.

Your password is never stored in plaintext, and your API key is never sent back
to the browser — the UI only receives a masked hint such as `sk-…a1b2`.

## Project fields

| Field | Values |
| --- | --- |
| **Title** | Free text, required. |
| **Idea** | The raw concept; ideas generated in the Idea Generator are imported here. |
| **Description** | Optional details, plan, or notes. |
| **Stage** | `Idea Stage`, `Reference Stage`, `Generation Stage`. |
| **Status** | `Not Started`, `In Progress`, `Done`. |
| **Priority** | `Low`, `Medium`, `High`. |
| **Reference Material** | Structured seven-section document generated in Reference Stage; editable and saved explicitly. |
| **Character References** | One generated reference document per character, shown under Reference Material. |
| **Scene Outline** | Array of scenes (`title`, `action`, `location`, `characters`) stored with the project. |
| **Generation Prompts** | One photorealistic image prompt per action reference, ordered, with per-prompt approval, review flags, and the rendered image. |
| **Scene Images** | Compatibility projection of the current asset version for each scene; authoritative files are tracked in the asset registry. |
| **Story Brief** | Canonical story root: title, logline, premise, tone, genre, audience, and setting summary. |
| **Character Bibles** | Stable-ID canonical character records with gender, age, appearance, wardrobe, continuity notes, and approval state. |
| **Location / Style References** | Stable-ID structured references with approval state, visual guidance, continuity notes, and style exclusions. |
| **Scene Matrix** | Ordered scenes with beat/action and ID links to approved characters and locations; legacy name fields remain for compatibility. |
| **Prompt Drafts** | Versioned prompt records with draft/final status, model/settings, exclusions, and reference-role mappings. |

Project Management has one tab per stage, plus a separate **Completed** tab.
Projects marked **Done** leave their stage tab and appear in **Completed** until
reopened. Status and search filters apply within each stage tab.

Reference Stage projects get a **→ Generation** button. It is disabled until
reference material has been saved; the server also rejects the transition with
`REFERENCE_REQUIRED` if the reference is empty.

A floating **Processing** panel in the bottom-right corner lists every active AI,
image-generation, and upload operation with a live elapsed timer. It remains
visible while switching tabs.

## Asset records and versions

Images are registered in an authoritative SQLite asset manifest:

- `assets` — stable UUID, project/episode/scene links, type, title, lifecycle
  status, and current version.
- `asset_versions` — immutable revision records with normalized relative path,
  source/derived flag, SHA-256 checksum, MIME, bytes, dimensions, provenance, and
  creation time.
- `episodes` — project-scoped ordered episodes.
- `collections` and `tags` — per-user organization with asset join tables.

The legacy `projects.scene_images` field remains as a compatibility projection
and now carries `assetId`, `versionId`, and `revision`. Replacing a generated or
uploaded scene image creates a new revision and preserves the previous file.
Project deletion archives its assets instead of deleting their source files.

The Library is backed by the asset registry and supports filters for project,
episode, collection, tag, type, lifecycle status, duplicate content, missing
files, and unassigned assets. Asset detail shows revision history, source/derived
state, checksum, duplicate peers, and organization controls. Project cards expose
an **Episodes** manager; asset detail can assign an episode and add tags or
collections. Missing review, approval, rights, and publication data remains
`Not recorded`.

Migration is transactional and creates a pre-migration database backup under
`data/backups/`. Asset backup/recovery helpers:

```bash
npm run backup -- ./backups/manual
npm run verify-assets
```

`npm run backup` snapshots SQLite and the image tree plus a manifest; the
verification script checks every recorded version against its SHA-256.

The first Phase 3 startup with existing projects also writes
`data/backups/app-pre-story-<timestamp>.db` before creating the structured story
tables.

To restore, stop the app, copy the backup's `app.db` to `data/app.db` and its
`images/` tree to `data/images/`, run `npm run verify-assets`, then restart. The
verification output reports missing or mismatched files before the app accepts
the restored registry.

## Story Workspace tab

The **Story Workspace** makes the story-to-image chain explicit:

1. Choose a project and fill in the **story brief**.
2. Create and approve **character bibles**, **locations**, and **style references**.
3. Build the ordered **scene matrix**, linking each scene only to approved
   character and location IDs.
4. Save prompt drafts as new versions; promote a version to **final** explicitly.
   Each version records text model, temperature/max tokens, image model/size,
   exclusions, and reference-role mappings.
5. Click **Check continuity** to surface missing/contradictory data. Warnings link
   back to the scene or reference; nothing is invented or silently corrected.

Saving a new prompt version appends history. Image generation remains a separate
explicit action, and promoting a prompt does not approve or publish an image.
Generated images record the matching prompt-draft ID when the prompt text matches
the latest draft.

Existing Reference and Generation Stage screens remain available. Reference
generation creates/updates canonical character and location records; existing
`scenes`, `generation_prompts`, and `character_references` data is migrated
additively without dropping the legacy fields.

## Reference Stage tab

1. Choose a project whose stage is **Reference Stage**.
2. Its **Idea** is loaded into the context field; refine it if needed.
3. Choose **1–4 characters** and enter a **name** and **gender** (`Male` or
   `Female`) for each one.
4. Enter a **setting** and click **✨ Generate reference material**.
5. DeepSeek returns structured JSON containing:
   - `referenceMaterial` with seven sections in order: Story Overview,
     Characters, Relationships, Setting, Story Progression, Visual Continuity,
     and Additional Notes.
   - `scenes` with 6–10 chronological scene outlines.
   - `characterReferences` with exactly one reference document per character.
6. All three are saved to the project. The reference appears in an editable
   textarea with **Save reference** and **Regenerate** buttons, and each
   character reference is displayed underneath it.

Reference generation replaces the saved reference, scene outline, and character
references after a confirmation prompt. Manually entered character names and
genders are preserved when regenerating. Reference generation uses DeepSeek 4 Pro
and normalizes common JSON variants such as object-shaped reference material or
snake_case field names. It never silently falls back to a different model.

## Character maker tab

Standalone characters, for designing a character and its reference image before
(or without) a project.

1. Open **🧑‍🎨 Character maker** and click **＋ New character**.
2. Give it a **name** and a **description**. The description is the prompt's
   character reference: age, build, height, hair, eyes, skin, wardrobe, and
   distinguishing details.
3. Choose the **image type**:
   - **Portrait** — one photorealistic head-to-mid-thigh image, no layout
     reference attached.
   - **Character sheet (3 views)** — the same shared front / three-quarter /
     side layout template the Story Workspace uses, attached as the reference
     image.
4. Choose an **image size** (1K, 1.5K, or 2K) and click **✨ Generate image**.
   The floating **Processing** widget shows the running generation, exactly like
   the other long steps.
5. Every generation appends a **version**. Click **Make final** on the one to
   keep, or **Copy prompt** to reuse the wording.

Characters belong to the signed-in user and to **no project**; other accounts
cannot read, generate for, or download them. Deleting a character deletes its
versions and removes its images from `data/images/characters/<characterId>/`.

**"Final" is not an approval.** It only marks which image is this character's
current reference. It does not touch the review checklist, publication decision,
or safe-cover state in the Library, and it never marks an asset as reviewed.

## Project characters tab

The same builder, scoped to one project and meant for building a project's cast.

1. Open **🎭 Project characters** and choose a **project** (completed projects are
   not listed).
2. Click **＋ New character**, then give it a **name** and a **description**.
3. Choose **Portrait** or **Character sheet (3 views)**, pick an image size, and
   click **✨ Generate image**.
4. Every generation appends a version. Click **Make final** on the one to keep, or
   **Copy prompt** to reuse the wording.

**Reuse from Character maker** copies the final image of a standalone
[Character maker](#character-maker-tab) character into the selected project
character. The bytes are copied into that character's own folder rather than
linked, so editing or deleting the standalone character afterwards never affects
the project; the copy becomes the project character's new final version.

The two tabs never share records: characters created with a project have a
`project_id` and are hidden from the Character maker tab, and standalone
characters (no `project_id`) are hidden here. Deleting a project cascades to its
project characters; deleting a character deletes its versions and its images.
Character images live in `data/images/characters/<characterId>/` and are **not**
registered as Library assets (the Library only indexes per-project image
folders), so copy an image into a project yourself if you want it reviewed,
tagged, or published.

## Standalone image generator tab

Prompt-to-image with **no project**, for one-off art, tests, and covers.

1. Open **🖼 Standalone images** and write a **prompt** (subject, setting,
   lighting, lens, mood, style).
2. Choose an **image size** and how many **images** to generate (1–4). Multi-image
   runs are sequential and each one appears in the gallery as it finishes, with
   the processing widget tracking `image 2 of 4`.
3. Click **✨ Generate**.

**Reference images.** Attach up to 10 references so the result follows a
character, place, or look: pick a **Library** image, a final **Character maker**
image, or **upload** a file (PNG/JPEG/WebP, 20 MB). The server resolves each one
to a data URL and re-checks ownership, so a client can never name an image it
does not own. Reference images are attached as visual guidance and are never
modified. They are capped at 24 MB in total per request.

**Prompt presets.** Save the current prompt under a name, then **Insert** it into
the prompt box later. Presets are per user.

### Every generated image is a Library asset

Generation also registers the image in the [Library](#library-tab) through the
asset registry, as a project-less asset. It therefore appears in the Library as
**unassigned** (the Library's *Unassigned* filter lists it) with the normal review
checklist, tags, collections, and publication decision. **🔎 Library** on any
gallery card opens it there.

The asset API accepts a `projectId` for one of these assets, but the Library UI
does not yet expose a project control (it can set tags, collections, and an
episode), so images are not filed into projects from the browser yet.

Deleting an image from this tab deletes the file, the generation record, and its
Library asset. Two guards protect work that would otherwise be lost:

- An image that has been **reviewed** (a review record or a publication decision
  exists) cannot be deleted here — the API answers `409 REVIEWED_ASSET`. Clear the
  review in the Library first.
- An image that has been **filed into a project** through the asset API cannot be
  deleted here — `409 ASSET_IN_PROJECT`, because it now belongs to that project.

Review records themselves are never deleted by this tab.

Images live in `data/images/characters/`-style UUID folders under
`data/images/generations/<generationId>/`, and uploaded references under
`data/images/generations/references/<referenceId>/`. Both are skipped by the
Library filesystem scan, which is why generated images appear in the Library only
through their registered asset row.

## Generation Stage tab

The Generation Stage is four explicit steps over one shared reference set. The
character references and the character reference sheets are the same for every
image in the story, which is what keeps the characters consistent.

1. Choose a project whose stage is **Generation Stage**. Its **References** card
   lists the character references, the final character reference sheets, the
   action references, and the location references, and names any blocker.
2. Click **✨ Build Image Prompts**. DeepSeek receives the reference material,
   the character references, the character reference sheets, the action
   references, and the location references, and returns exactly one image prompt
   per action reference. Nothing is saved yet: either **💾 Save image prompts**
   or **↻ Generate again**.
3. Approve every saved prompt individually with **✓ Approve**. Editing a prompt
   clears its approval and answers that prompt's review flags.
4. Click **🔎 Review the prompts**. A reviewer agent compares every image prompt
   with the character references, the character reference sheets, the action
   references, and the location references, and reports concrete
   inconsistencies. Each flag must be **✎ Edit prompt**-ed away or **Dismiss**-ed;
   dismissed and edited flags are kept as history.
5. Click **🖼 Run image generation process**. It renders every prompt one by one
   with that image's character reference sheets attached, and files each result
   into the project and the Library. Editing a prompt afterwards makes its
   existing image stale rather than silently current.

Saved prompts, approvals, review flags, and rendered images persist in SQLite, so
reopening or signing in again does not lose data. Updates are partial, so saving
prompts does not overwrite reference material or the story workspace.

Uploads accept PNG, JPEG, or WebP files up to 20 MB. Images are saved under
`data/images/`, attached to the project, and served through an authenticated
route. Image generation uses **Seedream 5.0 Pro** with the saved BytePlus key;
Seedream 5.0 Pro supports 1K/1.5K/2K.

## Library tab

The Library is a read-only visual index of image assets under `data/images`.

- Discovery is recursive and supports `.png`, `.jpg`, `.jpeg`, `.webp`, and `.gif`
  case-insensitively.
- Hidden files, system artifacts, unsupported files, malformed images, and
  unreadable entries are skipped without failing the page.
- The API returns normalized relative paths and app-owned URLs only; it never
  returns the machine's absolute image path.
- Detail view shows filename, relative path, type, dimensions, size, modified time,
  and authoritative project/scene provenance when available. Missing review,
  approval, rights, episode, or revision metadata is shown as `Not recorded`.
- A card never implies approval or publication. Generation approval and publication
  approval are explicitly separate and are not inferred from project status.
- Assets inside a UUID project directory are scoped to that project's owner.
  Shared assets outside UUID project directories are available to authenticated
  operators; this deployment has no separate operator role.
- No Library action uploads, deletes, renames, generates, approves, publishes, or
  syncs anything, and no local image is sent to DeepSeek to render the gallery.

Scene outlines and generated prompts persist in SQLite, so reopening or signing
in again does not lose data. Updates are partial, so saving scenes does not
overwrite reference material, and saving prompts does not overwrite ideas or
references.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port. |
| `APP_SECRET` | auto-generated in `data/secret.key` | Key material used to encrypt API keys at rest. Use a long random value in production and keep it stable. |
| `PUBLIC_ORIGIN` | unset | Optional exact browser origin, e.g. `https://app.example.com`. Useful when a reverse proxy rewrites `Host`; CSRF checks then compare against this value. |
| `BYTEPLUS_IMAGE_ENDPOINT` | `https://ark.ap-southeast.bytepluses.com/api/v3/images/generations` | Seedream image-generation endpoint. |
| `BYTEPLUS_IMAGE_MODEL` | `dola-seedream-5-0-pro-260628` | Fallback image model if a stored preference is unavailable; Seedream 5.0 Pro is the only supported model. |
| `DATA_DIR` | `./data` | Directory for the database, secret, and generated images. |
| `DB_PATH` | `<DATA_DIR>/app.db` | Explicit SQLite file path. |

```powershell
# Windows example
$env:APP_SECRET = "a-long-random-production-secret"
$env:PORT = 8080
node server.js
```

If `APP_SECRET` changes, previously saved API keys can no longer be decrypted;
users are prompted to save their key again. Back up the secret together with the
database.

## Data and backups

- `data/app.db` — users, sessions, and projects (SQLite, WAL mode).
- `data/app.db-wal` / `data/app.db-shm` — SQLite write-ahead log files.
- `data/secret.key` — only created when `APP_SECRET` is not set.
- `data/images/<project-id>/` — generated and uploaded images.
- `data/backups/` — pre-migration database backups and manual asset snapshots.

Back up the whole `data/` directory (or use `sqlite3 data/app.db ".backup ..."`).
`data/` and `.env` are git-ignored.

## Security model

- **Passwords:** scrypt with a random 16-byte salt per user; verification uses a
  constant-time comparison, and unknown usernames still pay the same hashing cost.
- **Sessions:** random 256-bit tokens. Only a SHA-256 hash is stored in SQLite.
  The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, valid for 7 days, and
  `Secure` when the request is HTTPS.
- **API keys:** DeepSeek and BytePlus keys are AES-256-GCM encrypted with a key
  derived from `APP_SECRET`. They are used only inside their respective
  server-side generation routes; no endpoint returns them.
- **CSRF:** every mutating API call must come from the same origin
  (`Origin`/`Sec-Fetch-Site` check), in addition to `SameSite=Lax`.
- **Login throttling:** 10 failed attempts per IP + username per 15 minutes.
- **Headers:** `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: same-origin`, and a restrictive CSP on HTML.
- **Authorization:** projects are always queried and mutated with `user_id`, so
  one account cannot read or change another account's data.

Always serve the app over HTTPS in production. If it runs behind a reverse proxy,
forward `X-Forwarded-Proto` (so session cookies get `Secure`) and preserve the
public `Host` header or send `X-Forwarded-Host` (the CSRF check compares it with
`Origin`).

## Upgrading from the localStorage version

On the first successful sign-in, if the account has no projects and this browser
still has `projectWorkflow.projects` in `localStorage`, they are imported once
and the local copy is kept as a backup. A previously remembered API key is *not*
migrated — enter it again under **AI APIs**.

Existing SQLite databases are migrated automatically on startup. The migration
adds the **Idea**, **Stage**, **Reference Material**, **Character References**,
**Scene Outline**, **Generation Prompts**, and **Scene Images** fields, adds the
per-user BytePlus key columns and text/image model preferences, creates the
authoritative **asset**, **asset version**, **episode**, **collection**, and
**tag** tables, backs up the database before asset migration, imports existing
scene images into asset versions, and registers unmanaged files under
`data/images`. It also creates the structured **story brief**, **character
bible**, **location reference**, **style reference**, and **prompt draft** tables;
migrates legacy character names, scene locations, and generation prompts into
those structures without deleting the legacy JSON fields; and normalizes old
model preferences to DeepSeek 4 Pro / Seedream 5.0 Pro. It also renames the old
`Backlog` status to `Not Started` and moves descriptions that came from the old
idea-import flow into **Idea**.

## Login troubleshooting

`GET /api/auth/me` returning 401 before sign-in is normal — it just means there is
no active session yet.

`POST /api/auth/login` returning 401 means the running app's database does not
contain that username/password combination. Check the startup log line:

```text
database: /path/to/app/data/app.db
```

If that path points at a new app folder, the app is using a new empty database.
Copy the old `data/app.db` plus `app.db-wal` and `app.db-shm` into the current
app's `data/` directory, then restart. If no old database exists, register a new
account. Do not overwrite `data/` during deployment.

## Deployment

This version **requires a running Node.js process** because `/api/*` handles
authentication, the database, and generation. A static-only host (for example
LiteSpeed serving `public/` directly) cannot run it; `/api/*` would return 404.
Run `node server.js` on the host and reverse-proxy HTTPS traffic to it, or deploy
to a Node-capable platform with a persistent disk for `data/`.

If you want to keep the existing static front end at `/public/`, leave those
files on LiteSpeed and reverse-proxy only `/api/*` to the Node process. Preserve
the public `Host` header (or send `X-Forwarded-Host`), send
`X-Forwarded-Proto: https`, and consider setting `PUBLIC_ORIGIN` to your exact
`https://` origin so CSRF checks do not depend on proxy headers.

- Set a stable `APP_SECRET` and persist the `data/` directory.
- Upload/deploy the repository, then run `npm start` (no build step).
- When `public/app.js` or `public/styles.css` changes, **bump the `?v=` value**
  on both links in `public/index.html`. Static caches are aggressive; an
  unversioned `app.js` previously kept browsers on an old client for a week.
- `public/.htaccess` only matters if the front end is served statically; it keeps
  HTML revalidating and limits JS/CSS caching to one hour.

The server is single-instance: SQLite and the in-memory login limiter assume one
process. Run one Node instance, or move to a shared database before scaling out.

## API overview

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create account and start a session. |
| `POST` | `/api/auth/login` | Sign in. |
| `POST` | `/api/auth/logout` | End the current session. |
| `GET` | `/api/auth/me` | Current user, key presence, masked hint. |
| `PUT` | `/api/me/api-key` | Encrypt and save the user's DeepSeek key. |
| `DELETE` | `/api/me/api-key` | Remove the saved DeepSeek key. |
| `PUT` | `/api/me/byteplus-key` | Encrypt and save the user's BytePlus key. |
| `DELETE` | `/api/me/byteplus-key` | Remove the saved BytePlus key. |
| `PUT` | `/api/me/ai-settings` | Save the preferred text and image models. |
| `GET` / `POST` | `/api/projects` | List / create projects. |
| `PUT` / `DELETE` | `/api/projects/:id` | Update / delete a project. |
| `POST` | `/api/projects/import` | One-shot import of legacy local projects. |
| `POST` | `/api/generate` | Generate ideas using the signed-in user's saved key. |
| `POST` | `/api/reference` | Generate structured reference material and scenes for a project. |
| `POST` | `/api/generation/build` | Build one image prompt per action reference from the shared references (draft, not saved). |
| `GET` | `/api/generation/:projectId` | Generation Stage state: reference bundle, blockers, and the saved task. |
| `PUT` | `/api/generation/:projectId/prompts` | Save the built image prompts. |
| `PUT` | `/api/generation/:projectId/prompts/:promptId` | Edit one saved image prompt (clears its approval and answers its flags). |
| `POST` | `/api/generation/:projectId/prompts/:promptId/approval` | Approve or unapprove one image prompt. |
| `POST` | `/api/generation/review` | Review the prompts against the references and store the flags. |
| `POST` | `/api/generation/:projectId/prompts/:promptId/flags/:flagId` | Dismiss one review flag. |
| `POST` | `/api/generation/images/one` | Render one image prompt with its reference sheets and file it into the project and Library. |
| `POST` | `/api/images/generate` | Generate a scene image with the selected Seedream model. |
| `POST` | `/api/images/upload` | Upload a PNG/JPEG/WebP scene image to a project. |
| `GET` | `/api/studio/:projectId/progress` | Story Studio overview for one story: one status per workflow step, the counts, and the next action. |
| `GET` | `/api/library` | List discoverable image assets under `data/images`. |
| `GET` | `/api/library/file?path=...` | Serve an allowlisted library image with root containment. |
| `GET` | `/api/assets` | List authoritative assets with project/episode/collection/tag/type/status/search/duplicate/missing filters. |
| `GET` | `/api/assets/:id` | Asset detail with versions, provenance, tags, collections, and duplicate peers. |
| `PUT` | `/api/assets/:id` | Update asset title, project, episode, or lifecycle context. |
| `GET` / `POST` | `/api/projects/:id/episodes` | List or create project episodes. |
| `PUT` / `DELETE` | `/api/episodes/:id` | Update or delete an episode. |
| `GET` / `POST` | `/api/collections` | List or create collections. |
| `PUT` / `DELETE` | `/api/collections/:id` | Update or delete a collection. |
| `POST` / `DELETE` | `/api/collections/:id/assets/:assetId` | Add/remove an asset from a collection. |
| `GET` / `POST` | `/api/tags` | List or create tags. |
| `PUT` / `DELETE` | `/api/tags/:id` | Update or delete a tag. |
| `POST` / `DELETE` | `/api/assets/:id/tags[/:tagId]` | Add/remove an asset tag. |
| `GET` | `/api/assets/duplicates` | List duplicate content groups. |
| `POST` | `/api/assets/sync` | Register newly discovered filesystem images. |
| `GET` | `/api/story/:projectId` | Load the story brief, references, scene matrix, prompt drafts, and continuity warnings. |
| `PUT` | `/api/story/:projectId/brief` | Update the structured story brief. |
| `POST` / `PUT` / `DELETE` | `/api/story/:projectId/characters`, `/api/story/characters/:id` | Manage character bibles. |
| `POST` / `PUT` / `DELETE` | `/api/story/:projectId/locations`, `/api/story/locations/:id` | Manage location references. |
| `POST` / `PUT` / `DELETE` | `/api/story/:projectId/styles`, `/api/story/styles/:id` | Manage style references. |
| `PUT` | `/api/story/:projectId/scenes` | Save the scene matrix; rejects missing/unapproved links. |
| `POST` | `/api/story/:projectId/scenes/:sceneId/prompts` | Append a prompt draft version. |
| `POST` | `/api/story/prompts/:id/promote` | Explicitly promote a draft to final. |
| `GET` | `/api/story/:projectId/validate` | Return continuity warnings without changing data. |
| `GET` | `/api/image/:projectId/:file` | Serve a generated image to its owner. |
| `GET` | `/api/health` | Liveness check (includes the app version). |
| `GET` / `POST` | `/api/characters` | List / create standalone Character maker characters. `?projectId=` lists one project's characters instead. |
| `PUT` / `DELETE` | `/api/characters/:id` | Rename, re-describe, or delete a character (and its images). |
| `POST` | `/api/characters/:id/generate` | Generate a portrait or a three-view character sheet as a new version. |
| `POST` | `/api/characters/:id/versions/:versionId/promote` | Mark one version final (exclusive per character). |
| `POST` | `/api/characters/:id/versions/import` | Copy another version's image into this character as a new final version. |
| `GET` | `/api/characters/:id/image/:file` | Serve a generated character image to its owner. |
| `GET` / `POST` | `/api/generations` | List generations with presets and references / generate one image from a prompt (up to 10 reference images). |
| `DELETE` | `/api/generations/:id` | Delete a generation, its file, and its Library asset (refused once reviewed or filed into a project). |
| `GET` | `/api/generations/:id/image/:file` | Serve a generated image to its owner. |
| `GET` / `POST` | `/api/generation-presets` | List / create prompt presets. |
| `PUT` / `DELETE` | `/api/generation-presets/:id` | Rename or delete a prompt preset. |
| `POST` | `/api/generation-references` | Upload a reference image for generation. |
| `GET` / `DELETE` | `/api/generation-references/:id/image`, `/api/generation-references/:id` | Serve or delete an uploaded reference image. |

## Project layout

- `server.js` — HTTP server, routing, auth/session middleware, DeepSeek and BytePlus proxies.
- `db.js` — SQLite schema and prepared queries (users, sessions, projects).
- `assets.js` — authoritative asset registry, migration, versions, duplicates, and organization.
- `story.js` — structured story workspace, reference bibles, scene links, prompt versions, and continuity validation.
- `characters.js` — standalone and project-scoped Character maker characters and their generated image versions.
- `standalone.js` — standalone image generations, prompt presets, and uploaded reference images.
- `security.js` — password hashing, API-key encryption, cookie helpers.
- `public/` — the entire front end (`index.html`, `styles.css`, `app.js`).
  `app.js` holds the module registry (`MODULES`), which declares each module's
  screens, the panel each screen activates, and its assistant guidance; adding a
  module means adding one registry entry plus the panels it points at.
- `scripts/` — dependency-free asset backup and verification utilities.
- `test/` — built-in `node:test` coverage for auth, assets, and Library.
- `data/` — created at runtime; holds the database, backups, secret, and generated images (git-ignored).

## Limitations

- No password reset or email verification (there is no email service).
- No roles or sharing; every account sees only its own projects.
- Generated ideas live in memory until you send them to Project Management.
- Image generation requires a valid BytePlus key and available Seedream quota.
- Uploaded images are limited to 20 MB and PNG/JPEG/WebP.
- Projects must be marked complete with **✓ Complete** to move to **Completed**.
- DeepSeek 4 Pro (`deepseek-v4-pro`) and Seedream 5.0 Pro
  (`dola-seedream-5-0-pro-260628`) are the only configured models. Existing
  accounts with older preferences are normalized on startup.
- Login rate limiting is per process and resets on restart.
