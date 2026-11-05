### Contributors: the search budget is judged in a workflow of its own

For contributors: the nightly job that judges the 100 ms search budget on a quiet hosted runner moves out of
`ci.yml` into `.github/workflows/search-budget.yml`, which runs at the same hour and by dispatch with nothing
else in it. A held or cancelled nightly `ci.yml` run no longer leaves the budget unjudged. `ci.yml`'s
dispatch loses its `judge_search_budget` input: dispatch `search-budget.yml` instead.
