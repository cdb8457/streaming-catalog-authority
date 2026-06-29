-- Phase 1 schema (DB-resident authority). Run as the OWNER/migrator role.
--
-- The database is the authority boundary. ALL mutation goes through SECURITY
-- DEFINER functions owned by the migrator; the runtime `app` role is granted
-- only SELECT on the tables and EXECUTE on the public command/maintenance
-- functions. Lifecycle invariants and the no-leak gate are enforced in the apply
-- path, so no caller can bypass them.
--
-- SECURITY DEFINER hardening against pg_temp shadowing:
--   * every table/function reference is schema-qualified (public.*),
--   * every function pins search_path = pg_catalog, public, pg_temp (pg_temp LAST
--     overrides its implicit "searched first for relations" behaviour),
--   * the app role is denied TEMPORARY on the database and CREATE on schema
--     public, so it cannot create shadowing objects in the first place.

-- ---------------------------------------------------------------- tables -----

CREATE TABLE IF NOT EXISTS events (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     TEXT NOT NULL,   -- opaque-uuid CHECK added below (idempotent, upgrade-safe)
  kind        TEXT NOT NULL CHECK (kind IN ('structural', 'behavioral')),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_item_seq_idx ON events (item_id, seq);
CREATE INDEX IF NOT EXISTS events_behavioral_ttl_idx ON events (expires_at) WHERE kind = 'behavioral';

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,   -- opaque-uuid CHECK added below (idempotent, upgrade-safe)
  present          BOOLEAN NOT NULL DEFAULT false,
  forgotten        BOOLEAN NOT NULL DEFAULT false,
  behavioral_score INTEGER NOT NULL DEFAULT 0,
  last_seq         BIGINT  NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  title            TEXT,   year INTEGER,            -- identity (NULL after rebuild)
  external_ids     JSONB,  metadata JSONB           -- identity (NULL after rebuild)
);

CREATE TABLE IF NOT EXISTS provider_refs (
  item_id    TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  ref_type   TEXT    NOT NULL,
  present    BOOLEAN NOT NULL DEFAULT true,
  ref_value  TEXT,                                   -- identity/secret (NULL after rebuild)
  PRIMARY KEY (item_id, ref_type)
);

-- --------------------------------------------- upgrade-safe migration steps --
-- Opaque-id CHECKs added idempotently so an upgrade from an older schema (which
-- created the tables without them) gains the constraints too.
--
-- CAVEAT: a *populated* pre-UUID database will fail here, because its old
-- non-opaque ids violate the new CHECK. There is no safe automated migration of
-- non-opaque ids (they were never opaque); such development volumes must be
-- reset. Fresh installs and empty/compatible upgrades are unaffected.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'items_id_uuid_chk') THEN
    ALTER TABLE items ADD CONSTRAINT items_id_uuid_chk
      CHECK (id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_item_id_uuid_chk') THEN
    ALTER TABLE events ADD CONSTRAINT events_item_id_uuid_chk
      CHECK (item_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');
  END IF;
END;
$$;

-- Remove objects superseded by later schema versions. Critically, this closes
-- the upgrade-path prune bypass: an older schema installed a bare, app-callable
-- prune_expired_behavioral() that deleted events without rebuilding.
DROP FUNCTION IF EXISTS prune_expired_behavioral(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS events_append_only();   -- legacy trigger fn, now unused

-- ------------------------------------------------------- append-only guard ---

CREATE OR REPLACE FUNCTION events_no_update_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'events are append-only: UPDATE is forbidden';
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'behavioral' AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN
      RETURN OLD;  -- legitimate TTL prune (only reachable via the prune function)
    END IF;
    RAISE EXCEPTION 'events are append-only: DELETE is forbidden (except expired behavioral)';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS events_append_only_trg ON events;
CREATE TRIGGER events_append_only_trg
  BEFORE UPDATE OR DELETE ON events FOR EACH ROW EXECUTE FUNCTION events_no_update_delete();

CREATE OR REPLACE FUNCTION events_no_truncate() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only: TRUNCATE is forbidden';
END;
$$;

DROP TRIGGER IF EXISTS events_truncate_guard ON events;
CREATE TRIGGER events_truncate_guard
  BEFORE TRUNCATE ON events FOR EACH STATEMENT EXECUTE FUNCTION events_no_truncate();

-- -------------------------------------------------------- validation core ----

-- No-leak gate. Validates the EXACT jsonb that will be stored (post-parse), so a
-- client-side toJSON()/getter cannot make validation and persistence disagree.
-- Messages are generic and value-free: a rejected value or type is never
-- interpolated, or it would leak into the PostgreSQL log.
CREATE OR REPLACE FUNCTION cat_validate_payload(p_type TEXT, p_payload JSONB)
RETURNS VOID LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op TEXT; v_w NUMERIC;
BEGIN
  IF p_type IN ('ItemAdded', 'ItemForgotten', 'ItemRestored') THEN
    IF p_payload <> '{}'::jsonb THEN RAISE EXCEPTION 'no-leak: payload not permitted for this event type'; END IF;

  ELSIF p_type = 'ProviderRefAttached' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 1 OR NOT (p_payload ? 'op') THEN
      RAISE EXCEPTION 'no-leak: provider ref payload shape is invalid';
    END IF;
    v_op := p_payload->>'op';
    IF v_op IS NULL OR v_op !~ '^[a-z0-9_]{1,32}$'
       OR v_op NOT IN ('infohash','tmdb','imdb','tvdb','tvmaze','anidb') THEN
      RAISE EXCEPTION 'no-leak: provider ref type is not allowed';
    END IF;

  ELSIF p_type = 'BehavioralSignal' THEN
    IF (SELECT count(*) FROM jsonb_object_keys(p_payload)) <> 1 OR NOT (p_payload ? 'weight') THEN
      RAISE EXCEPTION 'no-leak: behavioral payload shape is invalid';
    END IF;
    IF jsonb_typeof(p_payload->'weight') <> 'number' THEN RAISE EXCEPTION 'no-leak: behavioral weight is invalid'; END IF;
    v_w := (p_payload->>'weight')::numeric;
    IF v_w <> floor(v_w) OR v_w < 1 OR v_w > 1000 THEN RAISE EXCEPTION 'no-leak: behavioral weight is invalid'; END IF;

  ELSE
    RAISE EXCEPTION 'no-leak: unknown event type';
  END IF;
END;
$$;

-- Pure fold of one event onto the projection. No transition checks: only ever
-- called with already-validated events (live apply) or the trusted log (rebuild).
CREATE OR REPLACE FUNCTION cat_reduce(
  p_seq BIGINT, p_item_id TEXT, p_type TEXT, p_payload JSONB, p_expires_at TIMESTAMPTZ, p_cutoff TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_op TEXT; v_weight INTEGER;
BEGIN
  IF p_type = 'ItemAdded' THEN
    INSERT INTO public.items (id, present, forgotten, last_seq, updated_at)
    VALUES (p_item_id, true, false, p_seq, now())
    ON CONFLICT (id) DO UPDATE SET present = true, last_seq = EXCLUDED.last_seq, updated_at = now();

  ELSIF p_type = 'ItemRestored' THEN
    UPDATE public.items SET present = true, forgotten = false, last_seq = p_seq, updated_at = now()
     WHERE id = p_item_id;

  ELSIF p_type = 'ProviderRefAttached' THEN
    v_op := p_payload->>'op';
    INSERT INTO public.provider_refs (item_id, ref_type, present) VALUES (p_item_id, v_op, true)
    ON CONFLICT (item_id, ref_type) DO UPDATE SET present = true;
    UPDATE public.items SET last_seq = GREATEST(last_seq, p_seq), updated_at = now() WHERE id = p_item_id;

  ELSIF p_type = 'ItemForgotten' THEN
    INSERT INTO public.items (id, present, forgotten, last_seq, updated_at)
    VALUES (p_item_id, false, true, p_seq, now())
    ON CONFLICT (id) DO UPDATE
      SET forgotten = true, present = false,
          title = NULL, year = NULL, external_ids = NULL, metadata = NULL,
          last_seq = p_seq, updated_at = now();
    UPDATE public.provider_refs SET present = false, ref_value = NULL WHERE item_id = p_item_id;

  ELSIF p_type = 'BehavioralSignal' THEN
    IF p_expires_at <= p_cutoff THEN
      UPDATE public.items SET last_seq = GREATEST(last_seq, p_seq), updated_at = now() WHERE id = p_item_id;
    ELSE
      v_weight := (p_payload->>'weight')::integer;
      UPDATE public.items SET behavioral_score = behavioral_score + v_weight,
                              last_seq = GREATEST(last_seq, p_seq), updated_at = now()
       WHERE id = p_item_id;
    END IF;
  END IF;
END;
$$;

-- The single event-sourced mutator. Assumes the caller already holds the locks.
-- Enforces id opacity, envelope, payload, and the LIFECYCLE TRANSITION.
CREATE OR REPLACE FUNCTION cat_apply_internal(
  p_item_id TEXT, p_type TEXT, p_payload JSONB, p_expires_at TIMESTAMPTZ, p_cutoff TIMESTAMPTZ)
RETURNS BIGINT LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_kind TEXT; v_seq BIGINT; v_present BOOLEAN; v_forgotten BOOLEAN; v_exists BOOLEAN;
BEGIN
  IF p_item_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'item id must be opaque (uuid)';
  END IF;

  v_kind := CASE WHEN p_type = 'BehavioralSignal' THEN 'behavioral' ELSE 'structural' END;
  IF v_kind = 'behavioral' AND p_expires_at IS NULL THEN RAISE EXCEPTION 'behavioral event requires expiry'; END IF;
  IF v_kind = 'structural' AND p_expires_at IS NOT NULL THEN RAISE EXCEPTION 'structural event must not have expiry'; END IF;

  PERFORM public.cat_validate_payload(p_type, p_payload);

  SELECT present, forgotten INTO v_present, v_forgotten FROM public.items WHERE id = p_item_id;
  v_exists := FOUND;

  IF p_type = 'ItemAdded' THEN
    IF v_exists AND v_forgotten THEN RAISE EXCEPTION 'item is forgotten; use restore()'; END IF;
    IF v_exists AND v_present THEN RAISE EXCEPTION 'item already present'; END IF;
  ELSIF p_type = 'ItemRestored' THEN
    IF NOT v_exists OR NOT v_forgotten THEN RAISE EXCEPTION 'restore requires a forgotten item'; END IF;
  ELSIF p_type IN ('ProviderRefAttached', 'BehavioralSignal') THEN
    IF NOT v_exists OR v_forgotten OR NOT v_present THEN RAISE EXCEPTION 'event requires a present item'; END IF;
  END IF;
  -- ItemForgotten: always permitted; reduce creates/maintains the tombstone.

  INSERT INTO public.events (item_id, kind, type, payload, expires_at)
  VALUES (p_item_id, v_kind, p_type, p_payload, p_expires_at) RETURNING seq INTO v_seq;

  PERFORM public.cat_reduce(v_seq, p_item_id, p_type, p_payload, p_expires_at, p_cutoff);
  RETURN v_seq;
END;
$$;

-- ------------------------------------------------- public mutation surface ---

CREATE OR REPLACE FUNCTION cat_lock_item(p_item_id TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(4242, 1);                  -- shared maintenance lock
  PERFORM pg_advisory_xact_lock(hashtextextended(p_item_id, 0));  -- per-item exclusive
END;
$$;

CREATE OR REPLACE FUNCTION cat_apply(p_item_id TEXT, p_type TEXT, p_payload JSONB, p_expires_at TIMESTAMPTZ)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  RETURN public.cat_apply_internal(p_item_id, p_type, p_payload, p_expires_at, now());
END;
$$;

CREATE OR REPLACE FUNCTION cat_add_item(
  p_item_id TEXT, p_title TEXT, p_year INTEGER, p_external_ids JSONB, p_metadata JSONB, p_refs JSONB)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_present BOOLEAN; v_forgotten BOOLEAN; v_exists BOOLEAN; v_last BIGINT; v_seq BIGINT; r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  SELECT present, forgotten, last_seq INTO v_present, v_forgotten, v_last FROM public.items WHERE id = p_item_id;
  v_exists := FOUND;
  IF v_exists AND v_forgotten THEN RAISE EXCEPTION 'item is forgotten; use restore()'; END IF;
  IF v_exists AND v_present THEN RETURN v_last; END IF;   -- idempotent no-op

  v_seq := public.cat_apply_internal(p_item_id, 'ItemAdded', '{}'::jsonb, NULL, now());
  IF p_refs IS NOT NULL THEN
    FOR r IN SELECT jsonb_array_elements(p_refs) LOOP
      PERFORM public.cat_apply_internal(p_item_id, 'ProviderRefAttached', jsonb_build_object('op', r->>'type'), NULL, now());
      UPDATE public.provider_refs SET ref_value = r->>'value' WHERE item_id = p_item_id AND ref_type = r->>'type';
    END LOOP;
  END IF;
  UPDATE public.items SET title = p_title, year = p_year, external_ids = p_external_ids, metadata = p_metadata
   WHERE id = p_item_id;
  RETURN v_seq;
END;
$$;

CREATE OR REPLACE FUNCTION cat_restore(
  p_item_id TEXT, p_title TEXT, p_year INTEGER, p_external_ids JSONB, p_metadata JSONB, p_refs JSONB)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_seq BIGINT; r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  v_seq := public.cat_apply_internal(p_item_id, 'ItemRestored', '{}'::jsonb, NULL, now());  -- guards: must be forgotten
  IF p_refs IS NOT NULL THEN
    FOR r IN SELECT jsonb_array_elements(p_refs) LOOP
      PERFORM public.cat_apply_internal(p_item_id, 'ProviderRefAttached', jsonb_build_object('op', r->>'type'), NULL, now());
      UPDATE public.provider_refs SET ref_value = r->>'value' WHERE item_id = p_item_id AND ref_type = r->>'type';
    END LOOP;
  END IF;
  UPDATE public.items SET title = p_title, year = p_year, external_ids = p_external_ids, metadata = p_metadata
   WHERE id = p_item_id;
  RETURN v_seq;
END;
$$;

CREATE OR REPLACE FUNCTION cat_forget(p_item_id TEXT)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  RETURN public.cat_apply_internal(p_item_id, 'ItemForgotten', '{}'::jsonb, NULL, now());
END;
$$;

CREATE OR REPLACE FUNCTION cat_record_signal(p_item_id TEXT, p_weight INTEGER, p_ttl_ms BIGINT)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  RETURN public.cat_apply_internal(p_item_id, 'BehavioralSignal', jsonb_build_object('weight', p_weight),
                                   now() + (p_ttl_ms || ' milliseconds')::interval, now());
END;
$$;

-- ----------------------------------------------------------- maintenance -----

CREATE OR REPLACE FUNCTION cat_rebuild(p_cutoff TIMESTAMPTZ)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE e RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(4242, 1);  -- exclusive: no writer can interleave
  DELETE FROM public.items;                -- cascades to provider_refs
  FOR e IN SELECT seq, item_id, type, payload, expires_at FROM public.events ORDER BY seq ASC LOOP
    PERFORM public.cat_reduce(e.seq, e.item_id, e.type, e.payload, e.expires_at, p_cutoff);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION cat_prune_and_rebuild(p_cutoff TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n INTEGER; e RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(4242, 1);  -- exclusive
  DELETE FROM public.events WHERE kind = 'behavioral' AND expires_at IS NOT NULL AND expires_at <= p_cutoff;
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM public.items;
  FOR e IN SELECT seq, item_id, type, payload, expires_at FROM public.events ORDER BY seq ASC LOOP
    PERFORM public.cat_reduce(e.seq, e.item_id, e.type, e.payload, e.expires_at, p_cutoff);
  END LOOP;
  RETURN n;
END;
$$;

-- ------------------------------------------------------------- privileges ----

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app') THEN
    CREATE ROLE app LOGIN PASSWORD 'app';
  END IF;
END;
$$;

-- App can READ the tables, but cannot mutate them directly...
REVOKE ALL ON events, items, provider_refs FROM app;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT ON events, items, provider_refs TO app;

-- ...nor create objects that could shadow them inside SECURITY DEFINER functions.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app;
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM app', current_database());
END;
$$;

-- No function is callable by the world; the app gets only the public surface.
REVOKE ALL ON FUNCTION
  cat_validate_payload(TEXT, JSONB),
  cat_reduce(BIGINT, TEXT, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ),
  cat_apply_internal(TEXT, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ),
  cat_lock_item(TEXT),
  cat_apply(TEXT, TEXT, JSONB, TIMESTAMPTZ),
  cat_add_item(TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB),
  cat_restore(TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB),
  cat_forget(TEXT),
  cat_record_signal(TEXT, INTEGER, BIGINT),
  cat_rebuild(TIMESTAMPTZ),
  cat_prune_and_rebuild(TIMESTAMPTZ)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  cat_apply(TEXT, TEXT, JSONB, TIMESTAMPTZ),
  cat_add_item(TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB),
  cat_restore(TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB),
  cat_forget(TEXT),
  cat_record_signal(TEXT, INTEGER, BIGINT),
  cat_rebuild(TIMESTAMPTZ),
  cat_prune_and_rebuild(TIMESTAMPTZ)
TO app;
