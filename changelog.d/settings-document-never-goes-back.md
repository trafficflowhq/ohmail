### A restored backup no longer rolls back the settings stored in the mailbox

A desktop whose data folder was restored from a backup, or a phone or server whose database was, could
replace the settings stored in the mailbox with its older ones on its next write: a rule or a screener
decision made after the backup was gone for every device reading that mailbox. The newer settings are now
kept and offered for import, like settings another device left, also when a decision was made on the
restored device before it first went online. A server or app rolled back to a release before 0.30.20
(0.30.19 included) and forward again, ohmail Cloud and the published server images included, still treats
the settings that release saved as its own. After "Not now" on settings found under this device's own
name, the decisions made on this device reach the mailbox beside them, so removing the mailbox from a
phone after that no longer loses them. On the phone, a fresh install meeting a mailbox's settings no
longer saves an empty copy beside them, and after Import the mailbox carries the imported settings within
two passes instead of many minutes later, so another device reading the mailbox meanwhile no longer reads
empty settings.
