### A pull request under a Next route group runs only the tests it reaches

For contributors: a maintainer's pull request that changed a file under `apps/webapp/app/(product)/` or
`apps/mobile/app/(tabs)/` ran the whole test suite, because the per-PR test selector refused every path with
parentheses. It now reads a route group, a whole path segment `(name)`, as part of a path, and selects the
tests that file reaches, including the tests that read it by name. Parentheses in any other shape still run
the whole suite.
