### Letters from the noon hour no longer read as arriving after midnight on Android

On some Android phones every letter that arrived between 12:00 and 12:59 showed 00:xx in the Ohbox, Search and the
reader. The phone now takes its own zone's offset from the system clock rather than from the hour the date formatter
reports, and other zones from their named offset (phone; desktop and web were not affected).
