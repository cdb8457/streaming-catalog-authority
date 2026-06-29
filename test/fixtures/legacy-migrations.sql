-- Phase 1 schema (hardened). Run as the OWNER/migrator role.
--
-- Append-only is enforced by two independent layers:
--   1. Triggers reject UPDATE, non-prune DELETE, and TRUNCATE on events.
--   2. The runtime "app" role is granted only SELECT/INSERT on events, so it
--      cannot even reach those operations, and cannot disable the triggers.
-- Pruning of expired behavioral events is exposed only through a narrowly
-- privileged SECURITY DEFINER function.

CREATE TABLE IF NOT EXISTS events (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('structural', 'behavioral')),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ  -- NULL for structural; set for behavioral TTL (ADR-4)
);

CREATE INDEX IF NOT EXISTS events_item_seq_idx ON events (item_id, seq);
CREATE INDEX IF NOT EXISTS events_behavioral_ttl_idx
  ON events (expires_at) WHERE kind = 'behavioral';

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  present          BOOLEAN NOT NULL DEFAULT false,
  forgotten        BOOLEAN NOT NULL DEFAULT false,
  behavioral_score INTEGER NOT NULL DEFAULT 0,
  last_seq         BIGINT  NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  title            TEXT,   year INTEGER,          -- identity (NULL after rebuild)
  external_ids     JSONB,  metadata JSONB          -- identity (NULL after rebuild)
);

CREATE TABLE IF NOT EXISTS provider_refs (
  item_id    TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  ref_type   TEXT    NOT NULL,
  present    BOOLEAN NOT NULL DEFAULT true,
  ref_value  TEXT,                                 -- identity/secret (NULL after rebuild)
  PRIMARY KEY (item_id, ref_type)
);

-- 1a. No UPDATE ever; DELETE only for an EXPIRED behavioral event.
CREATE OR REPLACE FUNCTION events_no_update_delete() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'events are append-only: UPDATE is forbidden';
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'behavioral'
       AND OLD.expires_at IS NOT NULL
       AND OLD.expires_at <= now() THEN
      RETURN OLD;  -- legitimate TTL prune
    END IF;
    RAISE EXCEPTION 'events are append-only: DELETE is forbidden (except expired behavioral)';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_append_only_trg ON events;
CREATE TRIGGER events_append_only_trg
  BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION events_no_update_delete();

-- 1b. No TRUNCATE (row triggers do not fire on TRUNCATE, so a separate guard).
CREATE OR REPLACE FUNCTION events_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: TRUNCATE is forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS events_truncate_guard ON events;
CREATE TRIGGER events_truncate_guard
  BEFORE TRUNCATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_no_truncate();

-- Narrow prune surface: the only sanctioned way to remove events. Runs with the
-- owner's rights so the app role need not (and does not) hold DELETE on events.
CREATE OR REPLACE FUNCTION prune_expired_behavioral(cutoff TIMESTAMPTZ)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE n INTEGER;
BEGIN
  DELETE FROM events
   WHERE kind = 'behavioral' AND expires_at IS NOT NULL AND expires_at <= cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- 2. Least-privilege runtime role.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app';
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT, INSERT ON events TO app;                       -- append + read only
GRANT SELECT, INSERT, UPDATE, DELETE ON items TO app;        -- projection is mutable
GRANT SELECT, INSERT, UPDATE, DELETE ON provider_refs TO app;
GRANT EXECUTE ON FUNCTION prune_expired_behavioral(TIMESTAMPTZ) TO app;
REVOKE UPDATE, DELETE, TRUNCATE ON events FROM app;          -- explicit, belt-and-braces
