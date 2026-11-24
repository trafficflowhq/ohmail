# Tests

The suite for the code in this repository. This directory holds the tests that span packages; each
app and package keeps its own beside its source, in its `test/` directory.

    npx vitest run                                    # the default configuration, vitest.config.ts
    npx vitest run --config test/vitest.sqlite.config.ts   # the same services over the device's SQLite store

Files ending in `.pg.test.ts` need a Postgres database of their own. Start the one in the root
`docker-compose.yml` (`docker compose up -d db`), then create this checkout's database with
`bash scripts/lane-db.sh "$PWD"`; the suites read the file it writes, `.lane-db.env`.
