### The SQLite test run splits into five measured shards

For contributors: the second store's test run in `ci.yml` now runs in five shards of about nine minutes
of tests each, packed from a recent whole run, instead of four whose longest had grown to over sixteen
minutes and ran into its job's 20-minute bound on a busy runner. The shard map records each shard's
measured time, and `node test/support/ci-shards.mjs --check` refuses a shard over twelve minutes.
