### Operators: an old encryption key version can be retired

Once `run-kek-rewrap` reads no stored secret below the newest key version, its last lines name the exact change that retires the older versions, and the API and the worker then start without them (removing the first version used to stop both from starting). While a stored secret still names a retired version, the worker refuses to start, and the API keeps serving and answers 503 on `/health`; the self-host compose file does not pass the retirement setting on yet.
