### Your own server and ohmail Cloud run one API program

The API was wired twice, once for a self-hosted server and once for ohmail Cloud. It is one program
now, built from its settings; what Cloud does differently is one list. Nothing in a self-hosted
server's `.env` changes name or meaning. [One API program](docs/one-server.md) lists every setting
with its default.

On your own server:

- While the database is too busy to take a request, live updates, the sign-in redirect and
  attachment downloads now answer "try again" (503), where they answered a server error (500).
- The older three-variable object storage block is also read without `TF_STORAGE_KIND`. A storage
  or mail block that is only half set stops the server at start and names the variable, as before.
- A setting that only ohmail Cloud reads, set beside `OHMAIL_ORIGIN`, stops the server at start and
  names it, where it was ignored. There are eight, such as `TF_PUBLIC_SIGNUP` and `TF_ADMIN_SECRET`;
  none is in the bundled `.env.example`.
- The server can expire old sessions and finish queued unsubscribes on its own clock; nothing did
  either on a self-hosted server. The setting is `TF_API_CLOCKS=1` with `TF_ALERT_SECRET`. It is
  off by default, and the bundled compose file does not pass it yet.
