# Source coverage audit

Date: 2026-11-17  
Worker: this repository  
Sources read directly: `ScientificJournalSystem_BE_NodeJS` and `HyperDataLab/sjs-trending-be`

## Coverage summary

| Area | Worker status | Evidence and limits |
|---|---|---|
| Legacy BE route patterns | Present: 100/100 in the direct route inventory | Confirms method/path patterns, not every response or authorization edge case. |
| Trending BE route patterns | Present: 45/45 in the direct route inventory | Confirms method/path patterns, not complete behavior parity. |
| Worker route registry | 207 registered method/path operations; generated OpenAPI exposes 414 operations across root and `/api/v1` aliases | OpenAPI fixture verified both chat aliases and authentication metadata; counts establish registry coverage only. |
| Auth, user, project, catalog, billing, and admin flows | Ported to Worker/Firestore | Source and Worker handlers were compared in earlier audit sessions; not every branch has an Emulator contract fixture. |
| Analytics and research routes | Partial | Several analytics branches still read Firestore article snapshots/relations. Direct OpenAlex search and graph search are wired, but analytics are not yet fully based on OpenAlex. |
| Analytics jobs | Six trending job types supported; Worker queue consumer concurrency is 2 | Wrangler build validates queue config; no live Cloudflare Queue execution was run in this audit. |
| Chat statistics | Structured Firestore planner; 12 grouping dimensions, 16 aggregate metrics, multiple measures, and validated article/journal filters with AND/OR | Filter allowlist now covers source Article scalar/JSON/date columns plus hydrated Journal metadata. Inline fixtures cover numeric IDs, Journal identifiers, JSON text matching, date ranges, soft-delete rejection, and SQL-like field rejection. No Firestore Emulator chat-stat fixture was run for this continuation. |
| Chat arbitrary SQL | Partial | Source generates arbitrary PostgreSQL `SELECT` statements and retries a failed statement once. Worker retries one invalid structured plan after validation, but does not execute SQL; unsupported projections, joins, filters, and aggregates can still differ. |
| Chat AI provider fallback | Ported with deployment configuration | Source falls back from a failed remote provider to local Ollama. Worker does the same in development and supports a Worker-reachable `AI_FALLBACK_ENDPOINT`/`AI_FALLBACK_MODEL` in deployed environments. |
| OpenAlex scholarly reads | Partial | Article/author/journal/publisher/keyword/topic/taxonomy list and detail routes, global search, dashboard suggestions, project dashboard counts/trends/trending keywords, graph search, and author/topic/keyword article routes use OpenAlex with Firestore read-through query/entity caching. Journal routes join Firestore SJR/quartile/volume counts. Advanced analytics, some project-scoped searches, and some relation reports still read Firestore article snapshots. |
| Article graph search | Partial | Worker now searches OpenAlex works and derives article/author/source/topic/keyword/reference nodes and edges. Ranking and query parsing still differ from Neo4j Lucene. Redis search caching is not replicated. |
| PostgreSQL/Neo4j migration | Ported | Importer has explicit mappings for all 46 legacy Prisma models and preserves Neo4j node/edge identifiers; source audit and earlier migration fixtures recorded in session notes. |
| CORS, query sanitation, and API docs | Ported | CORS fixtures cover allow/deny, wildcard, localhost defaults, preflight, route and error responses. OpenAPI JSON/UI fixtures passed. |
| Local development | Configured | `npm run worker` uses port 43877; Firestore Emulator uses 43878 and UI 43879. See [README.md](README.md). |

## Checks run for this continuation

- `node --check src/features/chat.js` and `src/firestore/repository.js` passed.
- `npm run build` passed Wrangler dry-run: 683.53 KiB upload, 141.21 KiB gzip.
- New inline fixtures passed for numeric ID matching, Journal identifier filters, JSON reference matching, date range filtering, soft-delete rejection, and unknown SQL-like field rejection. Earlier inline fixtures covered CORS, OpenAPI paths/auth markers (414 operations), distinct metrics, combined metrics, AND/OR, planner repair, Vietnamese fallback, and graph-title ranking.
- Ollama provider-fallback behavior is implemented in this continuation; its mocked-provider fixture is pending.
- Live Worker checks returned HTTP 200 for `/` and `/api-docs.json`; Worker, Firestore Emulator, and Emulator UI ports 43877–43879 were listening. No Firestore Emulator chat-stat contract fixture was run for this continuation.

## Remaining work

1. Move Firestore-backed scholarly retrieval in advanced analytics and project-scoped searches to OpenAlex, while retaining curated ranking and issue/volume data in Firestore.
2. Decide and implement the Firestore equivalent for arbitrary RAG query plans; preserve project scope and source filters/aggregates while keeping execution restricted to registered collections and relations.
3. Run a mocked-provider fixture for the new Ollama fallback behavior.
4. Continue handler-by-handler source comparison for branches not backed by Emulator fixtures.
5. Add Emulator contract fixtures for chat statistics and graph search, then run the full project verification commands.

This audit does not claim full semantic parity. The remaining RAG query-generation gap is material.

## OpenAlex source and cache continuation (2026-11-17)

- OpenAlex is now the source for scholarly list/detail, global search/autocomplete, graph search, and author/topic/keyword article routes. Exact query results and entity documents use the Firestore read-through cache; refreshes write only changed/new records.
- Journal list/detail joins Firestore SJR, quartile, and volume-count data. Several advanced analytics and project-scoped retrieval paths still read Firestore article snapshots/relations, so this does not establish a complete OpenAlex migration.
- `node --check` passed for `src/features/records.js`, `src/features/research.js`, and `src/openalex/adapters.js`; `npm run build` passed Wrangler dry-run (724.06 KiB upload / 149.95 KiB gzip). Inline fixtures passed for author/topic/keyword OpenAlex filters and journal SJR/quartile/volume enrichment.
- Local `.dev.vars` contains an ignored 64-character encryption key and was modified before the active local Worker started. Wrangler `secret list` returned `Worker "scientificjournalsystem-api" not found`, so no remote Worker secret could be configured in this checkout.


## OpenAlex dashboard aggregation (2026-11-17)

- `/projects`, `/statistics/publication-trends`, and `/dashboard/trending-keywords` now use OpenAlex grouped work queries scoped by Firestore project tracking IDs; project membership/configuration remains in Firestore.
- Node syntax checks passed for the four changed Worker modules and Wrangler dry-run passed (742.12 KiB upload / 154.02 KiB gzip). No live Emulator/OpenAlex contract was run.
- Open issue: summed filter dimensions may overlap; broad area journal source grouping reads the first 200 groups.
