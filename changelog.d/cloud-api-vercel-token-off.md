### Cloud reads the API's server errors from the worker, and the API holds no platform token

ohmail Cloud counts the server errors (5xx) its API answers by reading the hosting platform's request
log. That read now runs in the worker, every five minutes, with a platform token of the worker's own:
`TF_SIGNAL_VERCEL_TOKEN` and `TF_SIGNAL_VERCEL_TEAM_ID`, `TF_SIGNAL_PROJECTS` for the projects to read
(`ohmail-api` when unset) and `TF_SIGNAL_SSE_OFF=1` while the API's live connection is off. The API no
longer reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID` or `VERCEL_SIGNAL_PROJECTS`, and its route
`GET /internal/platform-signals/run` is removed, so code running in the internet-facing API can no longer
reach a token that changes deployments. A worker without the `TF_SIGNAL_*` pair reads nothing, and the
operator console says "5xx: not measured" as before (Cloud).
