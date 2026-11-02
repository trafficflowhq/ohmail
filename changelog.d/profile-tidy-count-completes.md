### A worker set to count old settings copies reads all of them while the mailbox stays connected

On your own server, a worker set to only count the settings copies its tidy would remove
(`TF_PROFILE_TIDY=count`, the setting a first deploy reads) now reads every copy in a mailbox's settings folder
while the mailbox stays connected: 64 at a time, half a minute apart, until all are read, then a count once per
settings interval as before. Before, it read 64 per five-minute interval and started over whenever the mailbox
reconnected, so on a mailbox holding hundreds of copies the count never covered the whole folder. Counting still
removes nothing but the copy a new one replaces, and the default, which removes the old copies, is unchanged.
