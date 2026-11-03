-- 0177_device_stopword_stems — a word that shares a stopword's stem is read as typed.
-- device-only: the server's documents keep no stopword; this store's porter tables keep every word, so
-- `ines`, whose porter stem is `in`, matched every letter holding `in`. One porter row of the server's
-- stopwords tells a search which words share a stopword's stem; those are read in the unstemmed tables
-- (mail 0175). It holds no mail.
-- Replay-safe: the table is dropped and written again.

DROP TABLE IF EXISTS stopwords_fts;
--> statement-breakpoint
CREATE VIRTUAL TABLE stopwords_fts USING fts5(
  words,
  tokenize='porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO stopwords_fts(words) VALUES ('i me my myself we our ours ourselves you your yours yourself yourselves he him his himself she her hers herself it its itself they them their theirs themselves what which who whom this that these those am is are was were be been being have has had having do does did doing a an the and but if or because as until while of at by for with about against between into through during before after above below to from up down in out on off over under again further then once here there when where why how all any both each few more most other some such no nor not only own same so than too very s t can will just don should now');
