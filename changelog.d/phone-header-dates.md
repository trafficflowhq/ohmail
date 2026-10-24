### Letters on the phone show the date they were sent, whatever form their Date line takes

On Android and iOS, a letter whose Date line had no weekday, no seconds, the zone written `UT`, `Z` or
`+02:00`, a month in lower case, or a two-digit year was stored with the moment the phone read it as its
sent date, or with a date in the year 26. The phone now reads these dates as the desktop does, so such
letters show and sort by the time they were sent, and the Junk and Trash lists show their dates. Letters
the phone already stored keep the date they were stored with.

On every app, a Date line whose zone is a common name such as `CET`, `CEST`, `MEZ` or `JST` is read at
that zone's offset, instead of as the moment the letter was read. An ambiguous or unknown name is read
as before.
