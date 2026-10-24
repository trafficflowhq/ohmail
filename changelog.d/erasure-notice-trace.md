### Cloud erases a closed account only after its erasure warning was delivered

ohmail Cloud erases the account data of a subscription that stayed closed past its retention period, and
mails a warning in the week before. The erasure now waits until that warning was delivered. A warning that
never went out, because the mail limiter held it back or a run stopped before sending, goes out late and
names a date a week ahead, and the erasure waits for that date. After the erasure ohmail keeps when the
warning was delivered, under the account's random id only (no address, name or mail), for ten years, as
long as the billing record; then the hourly maintenance deletes it. A lifecycle mail that reached nobody is
no longer recorded as sent, and a later run sends it. Deleting your account yourself is unchanged.
