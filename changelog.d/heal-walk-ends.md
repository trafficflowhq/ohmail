### The worker's conversation-join repair finishes its rounds again

Since 0.30.18 the background repair that joins a conversation a forward split in two read the whole account's
address list again in every short slice of its work. On a large mailbox each slice then covered only one or two
conversations, so a round never finished and every sync round on ohmail Cloud spent about ten seconds on it. The
address list is now read once per account per round, and each account gets at most 30 seconds of repair per
six-hour round; a round cut short goes on where it stopped in the next one. Cloud and your own server.
