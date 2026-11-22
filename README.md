# Scientific Journal System Cloudflare Worker

This Worker ports the existing Fastify API and `sjs-trending-be` API onto Firestore. It keeps the legacy `/api/v1` routes, serves the trending API's root routes, and also accepts `/api/v1` aliases for those root routes. Project chat stays at `/api/v1/chat` and `/api/v1/projects/:projectId/chat/messages`.

## Local development

1. Install dependencies with `npm install` in this directory.
2. Copy `.dev.vars.example` to `.dev.vars`; it is configured for the local Firestore Emulator project `demo-sjs`. Set a long random `JWT_SECRET`. The sanitized `/api/v1/debug-auth` diagnostics are enabled only when `NODE_ENV=development`. Never commit `.dev.vars`.
3. In one terminal, run `npm run emulator` to start Firestore Emulator on port 43878 (Emulator UI: port 43879). The first run downloads Firebase CLI through `npx` if it is not installed.
4. In another terminal, start Ollama on port 11434 and pull the model in `AI_MODEL` (the default is `llama3.1:8b`).
5. Run `npm run worker` (alias: `npm run dev`) to start the Worker on port 43877. Firestore Emulator mode skips service-account authentication and sends all Firestore REST requests to `FIRESTORE_EMULATOR_HOST`.

`npm run emulator` starts Firestore and automatically runs `npm run seed:dev` after the emulator reports ready. The seed command is locked to project `demo-sjs` and loopback port `43878`; it upserts an active `STUDENT` and `ADMINISTRATOR` account, generates passwords when the FE `.env` values are blank, and writes those credentials only to the ignored sibling `sjs-fe-v2/.env`. Restart Vite if the seed generated or changed credentials. The seed never targets a remote Firestore instance. Run `npm run seed:dev` manually only when you need to recreate the accounts without restarting the emulator.

Wrangler dev also runs the configured Durable Objects locally. Chat rate limits and successful chat responses are shared through Durable Objects; set `CHAT_CACHE_TTL_SECONDS` in `.dev.vars` to expire cached answers, or leave it unset for source-compatible no-expiration behavior.

For remote AI, set `AI_PROVIDER=openai` and `AI_API_KEY` plus `AI_BASE_URL` (or use `AI_PROVIDER=gemini` with `GEMINI_API_KEY`). A provider failure falls back to local Ollama during development; deployed Workers can set `AI_FALLBACK_ENDPOINT` and optionally `AI_FALLBACK_MODEL` for an Ollama endpoint reachable from the Worker. Configure provider values as Worker vars/secrets for deployed environments; do not deploy the local Ollama URL.

## Firestore and deployment

Outside local emulator mode, the Worker uses Firestore REST with a service-account JWT. Configure `FIRESTORE_SERVICE_ACCOUNT_JSON` and `FIREBASE_PROJECT_ID` as Wrangler secrets; configure `FIRESTORE_DATABASE_ID`, CORS, AI provider/model, and provider callback URLs as vars. The service account needs Firestore data access. The Worker uses server credentials, so Firestore Security Rules do not replace API authorization checks. Do not set `FIRESTORE_EMULATOR_HOST` in deployed environments.

Create the queue resources before deployment:

```sh
npx wrangler queues create sjs-analytics
npx wrangler queues create sjs-analytics-dlq
npx wrangler deploy
```

Deploy Firestore composite and vector indexes with Firebase CLI from this directory using `firebase deploy --only firestore:indexes`. Vector search requires a vector index whose dimension matches the stored embeddings; update `firestore.indexes.json` if your embeddings are not 768-dimensional.

## API coverage

- OpenAPI JSON is served at `/api-docs.json` and the Swagger UI at `/api-docs`; the spec is generated from Worker routes and lists both root and `/api/v1` aliases.
- Auth, users, Google OAuth code exchange, password reset and verification, profile updates, admin user management.
- Articles, authors, publishers, journals, keywords, topics, subject areas/categories, volumes/issues, catalogs, zones and statistics.
- Projects, related articles, overview/analytics, restore/activate, memberships/invites, watched keywords and journal tracking.
- Search/autocomplete, dashboard summaries, publication/citation trends, journal impact and rankings, topic/frontier and forecast data, geographic distributions, collaboration graphs/chords/matrices, exports, and analytics job status/queue.
- Chat RAG, scoped project history/message CRUD, Firestore statistics with multi-dimension groups and multiple aggregate metrics, Ollama local inference and OpenAI-compatible/Gemini remote providers.
- Coin packages, wallet transactions/spending/adjustments, PayOS checkout/webhook and MoMo IPN.

OpenAlex is the upstream source for scholarly works, authors, sources/journals, publishers, institutions, keywords, topics, domains, and fields. The Worker requests those records from OpenAlex, stores entity records and exact query pages in Firestore, and serves repeated queries from that cache for `OPENALEX_CACHE_TTL_SECONDS` (default six hours). On refresh it writes only new or changed entity documents and ignores an older `updated_date`. Set `OPENALEX_API_KEY` as a Wrangler secret; the key is sent in the Authorization header and is never put in cache keys or URLs. Firestore remains the source for accounts, projects, billing, and curated data OpenAlex does not provide, including SJR/quartile and volume/issue records.

OpenAlex backs scholarly list/detail routes, global search/autocomplete, graph search, author/topic/keyword article lists, and dashboard project counts/publication trends/trending keywords. Dashboard aggregates query OpenAlex group counts from Firestore-stored project tracking IDs, using the existing Firestore read-through query cache. OpenAlex fields are adapted to existing response shapes, with OpenAlex IDs exposed alongside the numeric ID suffix used by existing routes. Journal list/detail responses join Firestore SJR, quartile, and volume-count data. Other advanced analytics still use Firestore article snapshots/relations in several branches and are not yet fully OpenAlex-backed. OpenAlex's `updated_date` filters are available to the configured Member+/Partner key; current request refreshes re-query the requested page and only persist changed entity documents.

Chat uses a structured Firestore query planner for supported entities, source Article scalar/JSON/date fields, hydrated Journal fields, metrics, and group dimensions. It retries one invalid planner response after validation and can use Ollama when a remote provider fails. It does not execute arbitrary AI-generated PostgreSQL SELECT statements or repair a failed SQL query, so open-ended projections and joins are still not equivalent. Neo4j full-text ranking is approximated with Firestore text matching; these behaviors are not semantically identical to the source services.

## PostgreSQL / Neo4j migration

The CLI is separate from the Worker runtime. It reads only process environment variables and does not load the parent repo's `.env`.

```sh
# PowerShell: set DATABASE_URL, FIREBASE_PROJECT_ID, and FIRESTORE_SERVICE_ACCOUNT_JSON first.
npm run migrate -- --pg-only

# Import both relational and graph data. Neo4j is skipped when its variables are absent.
npm run migrate

# Preview the PostgreSQL table/document plan without writing Firestore.
npm run migrate -- --pg-only --dry-run

# Restrict the import or cap rows per table / graph side.
npm run migrate -- --tables=Article,Author,Journal --max-rows=1000
npm run migrate -- --neo4j-only --max-rows=10000
```

The importer copies every public PostgreSQL base table into its mapped Firestore collection, keeps source columns, and records the original table/primary key. Neo4j nodes and relationships are copied to `graph_nodes` and `graph_edges`. Writes are idempotent upserts in batches of 400. Run the importer first against a staging Firestore database, review counts, then repeat against production. `--dry-run` still requires a reachable PostgreSQL database for row counts and schema inspection.

## Build

Run `npm run build` to bundle the Worker with Wrangler. This project does not deploy or import production data as part of the build.
