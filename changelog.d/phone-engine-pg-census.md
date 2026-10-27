### The test suite refuses Postgres-only SQL in code the phone carries

A query only the server's database understands, in a file the phone app's mail engine bundles, now fails
the main test suite, not only the Android build. On the phone the store is SQLite, where such a query
fails or answers a different question. Phone.
