### The desktop store's crash tests run again

The tests that kill the desktop app's local store mid-write and open it again (a first start killed at
each step, a kill in the middle of a sync, a kill mid-ingest, the data-directory lock) are back in the
suite, and so is the check that the API host keeps its mail and database drivers out of the bundle.
Nothing changes in the apps; these guard the desktop app and ohmail Cloud against regressions.
