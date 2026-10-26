### ohmail Cloud answers "busy, retry shortly" when the database pooler turns a request away

When the database pooler gives up on a statement it never passed to the database, ohmail Cloud now
answers "busy, retry shortly" instead of a server error. That statement did not run; an earlier
statement of the same request may already have been written.
