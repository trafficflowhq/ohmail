### Cloud asks the billing service again after a brief refusal in front of it

On ohmail Cloud, the network edge in front of the billing service sometimes refused a request for a moment,
before the billing service saw it, and the check then went unanswered. A check of an account's access, or of
the billing service's own state, is now asked again once after a short random pause, inside the same time
limit, so a brief refusal costs a little time instead. Charges and usage reports are never sent twice. A
refusal that persists is recorded as the edge's, so the record says which hop refused.
