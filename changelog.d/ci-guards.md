### Contributors: migration numbers are checked across open pull requests, and a stale npm cache file no longer fails CI

Two entries with one number on a migration journal now fail the test suite, and
`node scripts/migration-numbers.mjs --open-prs` prints the next number no open pull request holds; the
migration section of [CONTRIBUTING.md](CONTRIBUTING.md) says when to run it. A CI install that fails on a
temp file left in npm's cache by an earlier install removes that file and runs once more.
