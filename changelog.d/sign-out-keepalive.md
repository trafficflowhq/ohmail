### Closing the tab right after Sign out still signs out

On the web app and ohmail Cloud, a tab closed right after Sign out was pressed could go before its sign-out
reached the server. The session then stayed open there until a later visit finished the sign-out, and after a
week Safari could forget that one was owed. The browser now completes a sign-out that was on its way when the tab
closed, and one still waiting to be sent goes out as the tab closes.
