### Without the test services, the suite skips what needs them instead of failing

For contributors: `npm test` on a machine without the test services in `docker-compose.yml` no longer fails
about 535 files. Each run checks once whether Postgres, GreenMail, Dovecot and RustFS answer, prints a line
for each one that does not, and skips the files that need a missing one, naming the service and its address.
A service that answers but is broken still fails, and `TF_REQUIRE_PG`, `TF_REQUIRE_GREENMAIL`,
`TF_REQUIRE_DOVECOT` and `TF_REQUIRE_RUSTFS` set to `1` turn a missing one into a failure, as CI does.
[CONTRIBUTING.md](CONTRIBUTING.md) says how to run the suite either way.
