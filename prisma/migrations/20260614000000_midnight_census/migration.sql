-- Midnight census: one row per IST day with a JSON snapshot of every ward's
-- bed counts captured at 00:00, used by the History page.

CREATE TABLE IF NOT EXISTS midnight_census (
  id          SERIAL      PRIMARY KEY,
  census_date VARCHAR(10) NOT NULL,
  ts          BIGINT      NOT NULL,
  snapshot    TEXT        NOT NULL,
  CONSTRAINT midnight_census_date_unique UNIQUE (census_date)
);
