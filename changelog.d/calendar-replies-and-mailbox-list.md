### CalDAV replies reach the right invitation and mailbox lists refresh faster

CalDAV calendars use the signed-in account's scheduling address when you answer an invitation, so the reply updates the correct attendee even when two of your mailboxes were invited.

The hosted mailbox list sends its independent database reads together, reducing the waits during a refresh.
