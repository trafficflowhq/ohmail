### Sign-in and device sign-out are more reliable

Password and authenticator changes now check that the authorizing session is still active when the change takes effect. Staff recovery ends existing staff sessions as part of resetting the authenticator.

The phone keeps an offline sign-out pending until the server confirms it. It retries when the connection returns and shows where to remove the device if a retry can’t be saved.
