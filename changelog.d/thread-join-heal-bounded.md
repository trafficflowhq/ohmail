### New mail no longer waits behind the split-conversation repair

The six-hourly pass that rejoins conversations a forward split in two could hold a Cloud or self-hosted
worker for minutes, and new mail for every mailbox on that worker waited until it finished. It now
reads only the account it is repairing, finds each group's threads in one read instead of one per
group, and stops between two groups once its share of the cycle is spent, picking up where it left off
on the next cycles. The conversations it joins, and how it joins them, are unchanged.
