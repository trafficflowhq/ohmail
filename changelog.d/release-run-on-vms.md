### A maintainer's dispatched test run uses the maintainers' own runners

For contributors: when the maintainers' own runners are switched on, a test run a maintainer starts by
hand on `main` or on a `pr/` branch now runs its Linux jobs there, as the nightly does, instead of on
GitHub's runners. On those runners six suite shards run at once instead of three. A dispatch on any
other branch or tag, a bot's run and a fork's pull request still run on GitHub's runners.
