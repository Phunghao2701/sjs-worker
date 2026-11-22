# Agent Instructions

## Project
- This project is an ECMAScript module Cloudflare Worker. Its entry point is `src/index.js`.
- Read `README.md` and `package.json` for local setup, environment configuration, and available commands.
- Route handlers live under `src/features/`; shared HTTP, routing, and authentication code lives under `src/core/`; Firestore access lives under `src/firestore/`.

## Implementation
- Use Worker/Web Platform APIs in runtime code. PostgreSQL and Neo4j dependencies are for the separate migration script, not Worker handlers.
- Register endpoints through the existing route definitions and preserve the legacy API paths and response shapes. The router supports `/api/v1` aliases.
- Mark protected routes with `auth: true`; use `admin: true` for administrator-only endpoints. Project-scoped handlers should enforce membership with the existing project authorization helpers.
- Access Firestore through `FirestoreClient` and the repository helpers. Keep collection naming and document ID behavior compatible with existing records and imports.
- Preserve soft-delete, restore, validation, and numeric-ID behavior when changing record handlers.
- Treat API authorization as required: deployed Worker credentials access Firestore directly, so Firestore Security Rules do not replace handler-level checks.
- Read secrets from the configured environment. Do not commit `.dev.vars`, credentials, or secret values.

## Commands
- `npm run worker` starts the local Worker.
- `npm run emulator` starts the Firestore Emulator.
- `npm run build` runs Wrangler's dry-run build.
- `npm run migrate` runs the PostgreSQL/Neo4j importer; inspect its options and target configuration before invoking it.
- `package.json` currently defines no test or lint script.
