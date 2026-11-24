### Cloud's background Screener checks stay fast on large accounts

On Cloud, the background checks that file company impersonations and act on or suggest Screener decisions read each waiting sender's other mail once per run instead of once for every waiting sender. On an account with many large mailboxes they no longer run long enough to hit the database time limit and hold up the rest of the account's background work.
