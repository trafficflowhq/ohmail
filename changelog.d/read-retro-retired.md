### The server no longer ships a command that marks screened-out mail read

The worker carried a one-off operator command that marked every unread letter in Screened out and Spam as
read, a cleanup for the time when a Screener decision itself marked letters read. Since screening out and
Spam leave letters as they were, running it would have undone that, so the command is gone. Nothing changes
for anyone who never ran it; on your own server it leaves with the next server update.
