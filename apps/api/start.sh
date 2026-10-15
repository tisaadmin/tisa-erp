#!/bin/sh
# Container entrypoint: apply migrations, make sure base data exists, then start the server.
set -e
node dist/db/migrate.js
if [ "$SEED_DEMO" = "true" ]; then node dist/db/seed.js --demo; else node dist/db/seed.js; fi
exec node dist/index.js
