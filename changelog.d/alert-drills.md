### Operators can drill the alerts and see who acknowledged them

On ohmail Cloud and on your own server, `POST /internal/alerts/drill` with the `TF_ALERT_SECRET` bearer sends
every kind of alert once, marked `[DRILL]`, through each alert channel that is set up: the server's channels at
once, the worker's on its next alert pass. Every message carries one link. Opening it shows a page and records
nothing; pressing the page's button records, once and within 24 hours, that the message reached a person.
`GET /internal/alerts/drill` lists the last five drills with what each channel answered and which messages were
acknowledged. One drill an hour. A drill is kept apart from real alerts: it opens, closes and changes none of
them.
