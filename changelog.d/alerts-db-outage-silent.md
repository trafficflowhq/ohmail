### Operators: the pager reaches you when the database is down

Every alert pass starts by reading the database, so a database outage used to silence the pager, leaving only
`alert_pass_failed` log lines. Now the API's alert pass pages `alert_db_unreadable` on its configured channels
when it cannot use the database, without touching the database: a database that is stopped or unreachable, one
that answers but refuses the pass's work (read-only, out of disk, memory or connections, shut down), and one too
slow for the pass's reads to finish within 30 seconds. It pages again at most once an hour while it lasts (mail
at most every 6 hours), and sends one resolved notice to the webhook and Telegram when it is back. On a
self-hosted install this needs `TF_ALERT_SECRET` set beside the channels. The organizer stops with a stopped
database, because its leader lock lives there, and pages only when its lock outlives the fault (a hung, read-only
or full database, too many connections). New and optional, `TF_ALERT_HEARTBEAT_URL`: a ping URL from an outside
check service, requested after every completed pass, so a dead box or database alarms there
(`deploy/selfhost/.env.example` explains it).
