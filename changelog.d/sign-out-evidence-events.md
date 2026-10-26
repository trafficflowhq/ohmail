### The sign-in record says why a session ended

For operators. The clean-up that ends sign-ins unused for 60 days now leaves one `session_reaped` row in
`auth_events` for each session it ends, naming the session, its refresh family and the days it went unused
(`idle_d`); the operator console's account page lists it by name. The row a reused refresh token leaves
(`refresh_reuse_revoked`, and `refresh_attempt_revoked`) now also says how many renewals behind the presented
token was (`depth`) and how many seconds had passed since the family's last renewal (`tail_age_s`). Neither
says who renewed, and an ordinary renewal leaves no row saying where it came from. A `tail_age_s` under 900, one
access token's lifetime, means something renewed the family just before: a second copy, or the same client
presenting its previous token right after renewing (an answer it lost or never stored, or two of its own
renewals racing). A longer `tail_age_s`, whatever the `depth`, fits a client whose stored sign-in went back and
equally a copied profile or a stolen token that renewed elsewhere and then went quiet. Nothing reads the new keys
back: the reuse alert fires on every `refresh_reuse_revoked` row as before. The new keys carry no token, and a
`session_reaped` row has no IP. No migration, and nothing changes for the person signed in.
