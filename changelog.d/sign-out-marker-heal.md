### A session check already on its way no longer undoes Sign out

On the web app and ohmail Cloud, a tab that was checking or renewing the session when Sign out was pressed in
another tab could write the account's name back into the browser once its answer arrived, and a tab opened then
could show the mailbox. Only a sign-in names the account now. A browser that has lost the name gets it back from
its own session check, and only where nothing else is written.
