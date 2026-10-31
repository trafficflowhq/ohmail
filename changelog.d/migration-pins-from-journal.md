### A new database migration no longer breaks unrelated tests

The tests that check the migration journals keep the migrations already released pinned by name and
read the newer ones from the journals themselves, so adding a migration no longer turns them red,
while renaming or removing a released one still does. Nothing changes in the apps.
