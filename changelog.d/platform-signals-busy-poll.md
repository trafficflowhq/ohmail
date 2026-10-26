### The 5xx poll keeps working when ohmail Cloud is busy

For operators. When the API served more requests than one poll can page through, the platform-signals poll
answered 502 after 40 seconds although it had written the newest window, and the organizer paged
`api_cron_stale` for it. A window the poll has no time left for now waits for the next poll (`deferred` on the
`platform_signal_pass` line), and a window that stopped at its page budget is not read again.
