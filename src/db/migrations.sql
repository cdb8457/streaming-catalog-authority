-- Phase 1 schema: append-only event log + operational projection.
--
-- Boundary rules encoded here:
--   * events is the source of truth, append-only (enforced by trigger).
--   * items / provider_refs are the OPERATIONAL projection. Their identity
--     columns (title/year/external_ids/metadata, ref_value) are written by
--     command handlers in the same transaction as the event, but the identity
--     never enters an event payload, so a projection rebuild leaves them NULL.

CREATE TABLE IF NOT EXISTS events (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('structural', 'behavioral')),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ  -- NULL for structural; set for behavioral TTL (ADR-4 split)
);

CREATE INDEX IF NOT EXISTS events_item_seq_idx ON events (item_id, seq);
CREATE INDEX IF NOT EXISTS events_behavioral_ttl_idx
  ON events (expires_at) WHERE kind = 'behavioral';

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  -- operational state: derived purely from the event fold
  present          BOOLEAN NOT NULL DEFAULT false,
  forgotten        BOOLEAN NOT NULL DEFAULT false,
  behavioral_score INTEGER NOT NULL DEFAULT 0,
  last_seq         BIGINT  NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- identity: re-hydrated by AIOMetadata in a later phase; NULL after rebuild
  title            TEXT,
  year             INTEGER,
  external_ids     JSONB,
  metadata         JSONB
);

CREATE TABLE IF NOT EXISTS provider_refs (
  item_id    TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  ref_type   TEXT    NOT NULL,           -- operational label, e.g. 'infohash', 'tmdb'
  present    BOOLEAN NOT NULL DEFAULT true,
  ref_value  TEXT,                       -- identity/secret; NULL after rebuild
  PRIMARY KEY (item_id, ref_type)
);

-- Append-only guard.
--   * UPDATE on events is NEVER allowed.
--   * DELETE is allowed ONLY for an expired behavioral event (the TTL prune).
--     Structural events can never be deleted.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'events are append-only: UPDATE is forbidden';
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'behavioral'
       AND OLD.expires_at IS NOT NULL
       AND OLD.expires_at <= now() THEN
      RETURN OLD;  -- legitimate TTL prune
    END IF;
    RAISE EXCEPTION 'events are append-only: DELETE is forbidden (except expired behavioral events)';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only_trg ON events;
CREATE TRIGGER events_append_only_trg
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
