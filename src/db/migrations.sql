-- Phase 2 schema (DB-resident authority + crypto-shredding). Run as OWNER/migrator.
--
-- Identity is stored ONLY as ciphertext (items.identity_ct, provider_refs.ref_value_ct);
-- the plaintext never reaches the DB. Key-control lives in item_key_control, which is
-- INDEPENDENT of the rebuildable projection (no FK to items) so a projection rebuild can
-- never lose or resurrect key state. All mutation is through SECURITY DEFINER functions;
-- the app role has SELECT + EXECUTE on the command surface only, and cannot author raw
-- lifecycle events (that would bypass key-control / crypto-shred).
--
-- search_path/qualification hardening and append-only guards are unchanged from Phase 1.

-- ---------------------------------------------------------------- tables -----

CREATE TABLE IF NOT EXISTS events (
  seq         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id     TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('structural', 'behavioral')),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_item_seq_idx ON events (item_id, seq);
CREATE INDEX IF NOT EXISTS events_behavioral_ttl_idx ON events (expires_at) WHERE kind = 'behavioral';

CREATE TABLE IF NOT EXISTS items (
  id               TEXT PRIMARY KEY,
  present          BOOLEAN NOT NULL DEFAULT false,
  forgotten        BOOLEAN NOT NULL DEFAULT false,
  behavioral_score INTEGER NOT NULL DEFAULT 0,
  last_seq         BIGINT  NOT NULL DEFAULT 0,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  identity_ct      BYTEA            -- encrypted identity blob; NULL when absent/forgotten/un-hydrated
);

CREATE TABLE IF NOT EXISTS provider_refs (
  item_id       TEXT    NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  ref_type      TEXT    NOT NULL,
  present       BOOLEAN NOT NULL DEFAULT true,
  ref_value_ct  BYTEA,                -- encrypted ref value; NULL after forget/rebuild
  PRIMARY KEY (item_id, ref_type)
);

-- Key-control: independent of the rebuildable projection (NO FK to items).
CREATE TABLE IF NOT EXISTS item_key_control (
  item_id        TEXT PRIMARY KEY,
  key_id         TEXT NOT NULL,
  cur_epoch      INTEGER NOT NULL,
  operation_id   TEXT NOT NULL,
  shred_state    TEXT NOT NULL CHECK (shred_state IN ('active', 'shred_pending', 'shred_complete')),
  shred_op_id    TEXT,
  shredded_at    TIMESTAMPTZ,
  shred_receipt  TEXT,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- --------------------------------------------- upgrade-safe migration steps --
-- Opaque-id CHECKs (idempotent), and the Phase 1 -> Phase 2 identity-column move.
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

-- Move identity to ciphertext on upgrade from a Phase 1 schema (idempotent; no-op on fresh).
-- NOTE: pre-Phase-2 plaintext identity is intentionally DROPPED, not migrated — it was never
-- encrypted, so there is nothing to crypto-shred; such data must be re-hydrated post-upgrade.
ALTER TABLE items ADD COLUMN IF NOT EXISTS identity_ct BYTEA;
ALTER TABLE items DROP COLUMN IF EXISTS title;
ALTER TABLE items DROP COLUMN IF EXISTS year;
ALTER TABLE items DROP COLUMN IF EXISTS external_ids;
ALTER TABLE items DROP COLUMN IF EXISTS metadata;
ALTER TABLE provider_refs ADD COLUMN IF NOT EXISTS ref_value_ct BYTEA;
ALTER TABLE provider_refs DROP COLUMN IF EXISTS ref_value;

DROP FUNCTION IF EXISTS prune_expired_behavioral(TIMESTAMPTZ);
DROP FUNCTION IF EXISTS events_append_only();
-- superseded Phase 1 plaintext command functions (replaced by *_ct + coordinator):
DROP FUNCTION IF EXISTS cat_add_item(TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS cat_restore(TEXT, TEXT, INTEGER, JSONB, JSONB, JSONB);
DROP FUNCTION IF EXISTS cat_forget(TEXT);

-- ------------------------------------------------------- append-only guard ---

CREATE OR REPLACE FUNCTION events_no_update_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'events are append-only: UPDATE is forbidden';
  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'behavioral' AND OLD.expires_at IS NOT NULL AND OLD.expires_at <= now() THEN
      RETURN OLD;
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

-- Pure operational fold. NEVER writes identity ciphertext (that is done by the command
-- functions); on forget it CLEARS the ciphertext. Identity is re-hydrated post-rebuild.
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
      SET forgotten = true, present = false, identity_ct = NULL, last_seq = p_seq, updated_at = now();
    UPDATE public.provider_refs SET present = false, ref_value_ct = NULL WHERE item_id = p_item_id;
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

-- Single event-sourced mutator: id opacity + envelope + payload + LIFECYCLE TRANSITION.
-- OWNER-only at the app boundary (not granted to app) — lifecycle is authored exclusively
-- by the command functions below so key-control can never be bypassed.
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
  INSERT INTO public.events (item_id, kind, type, payload, expires_at)
  VALUES (p_item_id, v_kind, p_type, p_payload, p_expires_at) RETURNING seq INTO v_seq;
  PERFORM public.cat_reduce(v_seq, p_item_id, p_type, p_payload, p_expires_at, p_cutoff);
  RETURN v_seq;
END;
$$;

CREATE OR REPLACE FUNCTION cat_lock_item(p_item_id TEXT) RETURNS VOID
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(4242, 1);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_item_id, 0));
END;
$$;

CREATE OR REPLACE FUNCTION cat_apply(p_item_id TEXT, p_type TEXT, p_payload JSONB, p_expires_at TIMESTAMPTZ)
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  RETURN public.cat_apply_internal(p_item_id, p_type, p_payload, p_expires_at, now());
END;
$$;

-- ------------------------------------------------- ciphertext command surface

-- New-lineage create. Winner selection by INSERT ... ON CONFLICT on the
-- item_key_control PK (the CAS); the loser gets committed=false and destroys its
-- provisional key. Identity ciphertext is written by the winner only.
CREATE OR REPLACE FUNCTION cat_add_item_ct(
  p_item_id TEXT, p_op_id TEXT, p_key_id TEXT, p_epoch INTEGER, p_identity_ct BYTEA, p_refs JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows INTEGER; v_state TEXT; r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  INSERT INTO public.item_key_control (item_id, key_id, cur_epoch, operation_id, shred_state)
  VALUES (p_item_id, p_key_id, p_epoch, p_op_id, 'active')
  ON CONFLICT (item_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    -- a lineage row already exists: idempotent if active, but a non-active (forgotten/
    -- pending/complete) lineage means the item is forgotten -> reject (use restore()).
    SELECT shred_state INTO v_state FROM public.item_key_control WHERE item_id = p_item_id;
    IF v_state IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'item is forgotten; use restore()';
    END IF;
    RETURN false;  -- already present (active lineage) -> idempotent no-op for the loser
  END IF;
  -- winner: author the lifecycle + write ciphertext (transition guards apply, incl. forgotten)
  PERFORM public.cat_apply_internal(p_item_id, 'ItemAdded', '{}'::jsonb, NULL, now());
  IF p_refs IS NOT NULL THEN
    FOR r IN SELECT jsonb_array_elements(p_refs) LOOP
      PERFORM public.cat_apply_internal(p_item_id, 'ProviderRefAttached', jsonb_build_object('op', r->>'type'), NULL, now());
      UPDATE public.provider_refs SET ref_value_ct = decode(r->>'ct', 'hex')
       WHERE item_id = p_item_id AND ref_type = r->>'type';
    END LOOP;
  END IF;
  UPDATE public.items SET identity_ct = p_identity_ct WHERE id = p_item_id;
  RETURN true;
END;
$$;

-- In-lineage identity update: REUSES the active lineage key_id/epoch (design §6), only the
-- ciphertext changes (fresh nonces are produced app-side). No new key is provisioned.
CREATE OR REPLACE FUNCTION cat_update_identity_ct(p_item_id TEXT, p_identity_ct BYTEA, p_refs JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_state TEXT; r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  SELECT shred_state INTO v_state FROM public.item_key_control WHERE item_id = p_item_id;
  IF v_state IS DISTINCT FROM 'active' THEN RAISE EXCEPTION 'no active identity lineage to update'; END IF;
  UPDATE public.items SET identity_ct = p_identity_ct, updated_at = now()
   WHERE id = p_item_id AND present AND NOT forgotten;
  IF NOT FOUND THEN RAISE EXCEPTION 'cannot update identity on an absent/forgotten item'; END IF;
  IF p_refs IS NOT NULL THEN
    FOR r IN SELECT jsonb_array_elements(p_refs) LOOP
      PERFORM public.cat_apply_internal(p_item_id, 'ProviderRefAttached', jsonb_build_object('op', r->>'type'), NULL, now());
      UPDATE public.provider_refs SET ref_value_ct = decode(r->>'ct', 'hex')
       WHERE item_id = p_item_id AND ref_type = r->>'type';
    END LOOP;
  END IF;
END;
$$;

-- Restore after a COMPLETED shred: begins a FRESH lineage (new key_id/epoch).
CREATE OR REPLACE FUNCTION cat_restore_ct(
  p_item_id TEXT, p_op_id TEXT, p_key_id TEXT, p_epoch INTEGER, p_identity_ct BYTEA, p_refs JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows INTEGER; r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  UPDATE public.item_key_control
     SET key_id = p_key_id, cur_epoch = p_epoch, operation_id = p_op_id,
         shred_state = 'active', shred_op_id = NULL, shredded_at = NULL, shred_receipt = NULL,
         updated_at = now()
   WHERE item_id = p_item_id AND shred_state = 'shred_complete';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RAISE EXCEPTION 'restore requires a completed shred'; END IF;
  PERFORM public.cat_apply_internal(p_item_id, 'ItemRestored', '{}'::jsonb, NULL, now());
  IF p_refs IS NOT NULL THEN
    FOR r IN SELECT jsonb_array_elements(p_refs) LOOP
      PERFORM public.cat_apply_internal(p_item_id, 'ProviderRefAttached', jsonb_build_object('op', r->>'type'), NULL, now());
      UPDATE public.provider_refs SET ref_value_ct = decode(r->>'ct', 'hex')
       WHERE item_id = p_item_id AND ref_type = r->>'type';
    END LOOP;
  END IF;
  UPDATE public.items SET identity_ct = p_identity_ct WHERE id = p_item_id;
END;
$$;

-- Forget coordinator, DB step 1: append ItemForgotten (clears ciphertext via reduce) and mark
-- shred_pending, returning the key lineage to destroy. Returns needs_destroy=false when there
-- is no key (item never had encrypted identity) — items.forgotten is still the tombstone.
CREATE OR REPLACE FUNCTION cat_forget_begin(p_item_id TEXT,
  OUT key_id TEXT, OUT shred_op_id TEXT, OUT needs_destroy BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_state TEXT; v_existing_op TEXT;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  PERFORM public.cat_apply_internal(p_item_id, 'ItemForgotten', '{}'::jsonb, NULL, now());
  SELECT ikc.key_id, ikc.shred_state, ikc.shred_op_id
    INTO key_id, v_state, v_existing_op
    FROM public.item_key_control ikc WHERE ikc.item_id = p_item_id;
  IF key_id IS NULL THEN
    shred_op_id := NULL; needs_destroy := false; RETURN;          -- no key; tombstone only
  ELSIF v_state = 'shred_complete' THEN
    shred_op_id := NULL; needs_destroy := false; RETURN;          -- already shredded
  ELSIF v_state = 'shred_pending' THEN
    shred_op_id := v_existing_op; needs_destroy := true; RETURN;  -- retry: reuse op id
  ELSE
    shred_op_id := gen_random_uuid()::text;
    UPDATE public.item_key_control
       SET shred_state = 'shred_pending', shred_op_id = cat_forget_begin.shred_op_id, updated_at = now()
     WHERE item_id = p_item_id;
    needs_destroy := true; RETURN;
  END IF;
END;
$$;

-- Forget coordinator, DB step 3: mark complete only after the custodian confirmed destruction.
CREATE OR REPLACE FUNCTION cat_forget_complete(p_item_id TEXT, p_shred_op_id TEXT, p_receipt TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  UPDATE public.item_key_control
     SET shred_state = 'shred_complete', shredded_at = now(), shred_receipt = p_receipt, updated_at = now()
   WHERE item_id = p_item_id AND shred_op_id = p_shred_op_id AND shred_state = 'shred_pending';
  -- idempotent: 0 rows if already complete
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
  PERFORM pg_advisory_xact_lock(4242, 1);
  DELETE FROM public.items;                  -- cascades to provider_refs; item_key_control untouched
  FOR e IN SELECT seq, item_id, type, payload, expires_at FROM public.events ORDER BY seq ASC LOOP
    PERFORM public.cat_reduce(e.seq, e.item_id, e.type, e.payload, e.expires_at, p_cutoff);
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION cat_prune_and_rebuild(p_cutoff TIMESTAMPTZ)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n INTEGER; e RECORD;
BEGIN
  PERFORM pg_advisory_xact_lock(4242, 1);
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

REVOKE ALL ON events, items, provider_refs, item_key_control FROM app;
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT ON events, items, provider_refs, item_key_control TO app;

REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM app;
DO $$
BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM app', current_database());
END;
$$;

REVOKE ALL ON FUNCTION
  cat_validate_payload(TEXT, JSONB),
  cat_reduce(BIGINT, TEXT, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ),
  cat_apply_internal(TEXT, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ),
  cat_lock_item(TEXT),
  cat_apply(TEXT, TEXT, JSONB, TIMESTAMPTZ),
  cat_add_item_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_update_identity_ct(TEXT, BYTEA, JSONB),
  cat_restore_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_forget_begin(TEXT),
  cat_forget_complete(TEXT, TEXT, TEXT),
  cat_record_signal(TEXT, INTEGER, BIGINT),
  cat_rebuild(TIMESTAMPTZ),
  cat_prune_and_rebuild(TIMESTAMPTZ)
FROM PUBLIC;

-- App gets the ciphertext command surface + maintenance. NOT cat_apply (raw lifecycle would
-- bypass key-control/crypto-shred) and NOT the internal helpers.
GRANT EXECUTE ON FUNCTION
  cat_add_item_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_update_identity_ct(TEXT, BYTEA, JSONB),
  cat_restore_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_forget_begin(TEXT),
  cat_forget_complete(TEXT, TEXT, TEXT),
  cat_record_signal(TEXT, INTEGER, BIGINT),
  cat_rebuild(TIMESTAMPTZ),
  cat_prune_and_rebuild(TIMESTAMPTZ)
TO app;
