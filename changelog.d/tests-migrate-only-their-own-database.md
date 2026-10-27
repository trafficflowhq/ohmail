### Tests that migrate a database refuse the shared test database

For contributors: the test files that apply the migrations to the database they are handed (the
repository adapter, the rules schema, the worker's leader lock and its end-to-end mail tests) now take
their database through the same refusal as the other Postgres tests. In a checkout without its own
database (`scripts/lane-db.sh`) they stop at collection with the remedy, instead of migrating the shared
`trafficflow_test` database another checkout is testing on.
