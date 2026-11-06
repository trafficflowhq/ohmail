### A worker with half its platform credential pages instead of going quietly dark

For your own server and ohmail Cloud: when the worker holds only one of `TF_SIGNAL_VERCEL_TOKEN` and
`TF_SIGNAL_VERCEL_TEAM_ID`, its 5xx poll no longer counts as healthy and no longer prunes the readings it
already has, so the platform poll's stale alert pages and the missing-readings alert stays open until the
pair is complete. The poll also reads up to 16 log pages per window under a 45 s clock sized for the worker,
in place of the 12 pages and 40 s that were sized for the API host.
