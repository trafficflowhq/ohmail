### Cloud: an unchanged mailbox costs less to check

When nothing has changed, each check the apps make for changes now costs the server two database statements
instead of four: the two that record when a sync last finished run only when that record is due, once every five
minutes.
