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
DROP FUNCTION IF EXISTS cat_forget_complete(TEXT, TEXT, TEXT);        -- pre-attestation form
DROP FUNCTION IF EXISTS cat_forget_complete(TEXT, TEXT, TEXT, TEXT);  -- op-bound attestation form

-- pgcrypto provides hmac() for verifying the custodian's destruction attestation.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Completion secret shared between the DB and the (production: external) custodian, never
-- the app. The app role has NO access to this table, so it cannot compute a valid attestation
-- and therefore cannot fabricate a shred completion.
--
-- Seeded with a RANDOM, unknowable value (not a constant an attacker could import). The
-- operator MUST set this to the secret shared out-of-band with the external custodian
-- (e.g. SELECT set_completion_secret('...')); until then, completion attestations cannot
-- verify, so a shred can never be falsely marked complete.
CREATE TABLE IF NOT EXISTS crypto_config (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  completion_secret TEXT NOT NULL
);
INSERT INTO crypto_config (id, completion_secret)
VALUES (1, gen_random_uuid()::text)
ON CONFLICT (id) DO NOTHING;

-- Owner-only setter for the completion secret (Phase 5). Operators provision/rotate the secret
-- out-of-band with this instead of a raw UPDATE. SECURITY DEFINER + revoked from PUBLIC and the
-- app role (below): the least-privileged runtime role can NEVER set it (and cannot read it), so it
-- cannot fabricate a destruction attestation. Validates a non-empty value; touches only id = 1.
CREATE OR REPLACE FUNCTION public.set_completion_secret(p_secret TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_secret IS NULL OR length(btrim(p_secret)) = 0 THEN
    RAISE EXCEPTION 'completion secret must be non-empty';
  END IF;
  UPDATE public.crypto_config SET completion_secret = p_secret WHERE id = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.set_completion_secret(TEXT) FROM PUBLIC;

-- Schema/migration version (Phase 6). ops:migrate sets this to the app's MIGRATION_VERSION so
-- ops:doctor can detect an un-migrated or version-mismatched deployment. Owner-only setter; the
-- app role can never read or change it (privileges below). No down-migrations — the accepted
-- rollback is restoring the pre-upgrade backup.
CREATE TABLE IF NOT EXISTS schema_meta (
  id      INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version INTEGER NOT NULL DEFAULT 0
);
INSERT INTO schema_meta (id, version) VALUES (1, 0) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.set_schema_version(p_version INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_version IS NULL OR p_version < 0 THEN RAISE EXCEPTION 'schema version must be a non-negative integer'; END IF;
  UPDATE public.schema_meta SET version = p_version WHERE id = 1;
END;
$$;
REVOKE ALL ON FUNCTION public.set_schema_version(INTEGER) FROM PUBLIC;

-- Durable abort fence: an operation_id recorded here can never commit a lineage. The
-- reconciler fences an orphaned provisional key under the per-item lock (only if it has not
-- committed), then destroys it — closing the reconciler-vs-live-writer TOCTOU.
--
-- WARNING: do NOT prune this table by age alone. A fence may only be forgotten once its
-- operation can provably never arrive (an enforced operation-expiry protocol — e.g. a signed
-- op deadline the writers also reject past). Age-pruning without that reopens the TOCTOU: a
-- delayed writer whose fence was pruned could commit a key the reconciler already destroyed.
CREATE TABLE IF NOT EXISTS aborted_operations (
  operation_id TEXT PRIMARY KEY,
  aborted_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Publish ledger (Phase 9): an IDENTITY-FREE audit of external publishes and the driver for
-- best-effort revocation on forget. It stores ONLY the opaque item_id (NO FK to items — the
-- tombstone must SURVIVE forget so a revoke can be driven), a non-identity target name, the opaque
-- external handle the publisher returned, and the NAMES of the fields that were disclosed. It NEVER
-- stores title, ref values, externalIds, metadata, or ciphertext; the disclosed_fields CHECK
-- rejects anything that is not one of the allowed field names, so a value can never be stored here.
-- Owner-managed: the app writes it only through the cat_publish_* SECURITY DEFINER functions (SELECT
-- only otherwise). Records LIVE publishes only — a dry-run creates no row.
-- Phase 12 extends this to a durable publish-intent OUTBOX (still identity-free): a `correlation_token`
-- (opaque idempotency/recovery key — a durable pointer to the external collection, tagged with the same
-- token) and a nullable `external_handle` (unknown until a create is confirmed), plus intent lifecycle
-- states. The token — NOT an in-memory response handle — is the recovery source of truth: an ambiguous
-- create is reconciled by searching the external system for the token (adopt the handle, or prove gone).
CREATE TABLE IF NOT EXISTS publish_ledger (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id           TEXT NOT NULL CHECK (item_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  target            TEXT NOT NULL CHECK (length(btrim(target)) > 0),
  external_handle   TEXT CHECK (external_handle IS NULL OR length(btrim(external_handle)) > 0), -- NULL until captured
  correlation_token TEXT,                                                                       -- opaque; identity-free
  disclosed_fields  TEXT[] NOT NULL DEFAULT '{}'
                      CHECK (disclosed_fields <@ ARRAY['title','year','providerRefs']::text[]),
  status            TEXT NOT NULL DEFAULT 'published'
                      CONSTRAINT publish_ledger_status_chk
                      CHECK (status IN ('planned', 'in_flight', 'ambiguous', 'published', 'revoke_pending', 'revoked', 'failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS publish_ledger_item_idx ON publish_ledger (item_id);
CREATE INDEX IF NOT EXISTS publish_ledger_status_idx ON publish_ledger (status);
CREATE UNIQUE INDEX IF NOT EXISTS publish_ledger_token_uk ON publish_ledger (correlation_token) WHERE correlation_token IS NOT NULL;

-- v2 -> v3 upgrade (idempotent; no-ops on a fresh v3 table): add the token, allow a NULL handle, and
-- replace the old 3-value status CHECK with the 7-state one.
ALTER TABLE publish_ledger ADD COLUMN IF NOT EXISTS correlation_token TEXT;
ALTER TABLE publish_ledger ALTER COLUMN external_handle DROP NOT NULL;
DO $$
DECLARE c_name TEXT;
BEGIN
  FOR c_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.publish_ledger'::regclass AND contype = 'c'
       AND conname <> 'publish_ledger_status_chk'
       AND pg_get_constraintdef(oid) ILIKE '%status%revoked%'
  LOOP EXECUTE format('ALTER TABLE public.publish_ledger DROP CONSTRAINT %I', c_name); END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'publish_ledger_status_chk' AND conrelid = 'public.publish_ledger'::regclass) THEN
    ALTER TABLE public.publish_ledger ADD CONSTRAINT publish_ledger_status_chk
      CHECK (status IN ('planned', 'in_flight', 'ambiguous', 'published', 'revoke_pending', 'revoked', 'failed'));
  END IF;
END $$;

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
  ELSIF p_type IN ('ProviderRefAttached', 'ProviderRefDetached') THEN
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
  ELSIF p_type = 'ProviderRefDetached' THEN
    v_op := p_payload->>'op';
    UPDATE public.provider_refs SET present = false, ref_value_ct = NULL
     WHERE item_id = p_item_id AND ref_type = v_op;
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
  ELSIF p_type IN ('ProviderRefAttached', 'ProviderRefDetached', 'BehavioralSignal') THEN
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
  IF EXISTS (SELECT 1 FROM public.aborted_operations WHERE operation_id = p_op_id) THEN
    RAISE EXCEPTION 'operation was aborted';   -- reconciler fenced this provisional key
  END IF;
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
DECLARE v_state TEXT; r JSONB; v_detach TEXT;
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
  -- REPLACEMENT semantics, EVENT-SOURCED: any currently-present ref NOT in the new set is
  -- removed by authoring an opaque ProviderRefDetached event (so the removal survives a
  -- projection rebuild), whose reducer deactivates the ref and clears its ciphertext.
  FOR v_detach IN
    SELECT ref_type FROM public.provider_refs
     WHERE item_id = p_item_id AND present
       AND ref_type NOT IN (SELECT x->>'type' FROM jsonb_array_elements(COALESCE(p_refs, '[]'::jsonb)) x)
  LOOP
    PERFORM public.cat_apply_internal(p_item_id, 'ProviderRefDetached', jsonb_build_object('op', v_detach), NULL, now());
  END LOOP;
END;
$$;

-- Restore after a COMPLETED shred: begins a FRESH lineage (new key_id/epoch).
CREATE OR REPLACE FUNCTION cat_restore_ct(
  p_item_id TEXT, p_op_id TEXT, p_key_id TEXT, p_epoch INTEGER, p_identity_ct BYTEA, p_refs JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_rows INTEGER; r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  IF EXISTS (SELECT 1 FROM public.aborted_operations WHERE operation_id = p_op_id) THEN
    RAISE EXCEPTION 'operation was aborted';
  END IF;
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

-- Forget coordinator, DB step 3: mark complete ONLY after verifying the custodian's
-- destruction attestation (HMAC over key_id:shred_op_id under the owner-only completion
-- secret). The app cannot forge this, so it cannot fabricate erasure. Returns whether the
-- row actually transitioned.
-- The attestation binds the DESTRUCTION STATEMENT (key_id, receipt_id, destroyed_at), NOT the
-- shred operation id — so a custodian destroy that is idempotent on key_id returns a stable,
-- still-verifiable attestation even when a NEW shred operation (e.g. old-backup self-heal)
-- drives completion. The canonical message is newline-joined; the three fields are strictly
-- formatted (key_/rcpt_ + uuid, ISO-8601) and contain no newline, so it is unambiguous.
CREATE OR REPLACE FUNCTION cat_forget_complete(
  p_item_id TEXT, p_shred_op_id TEXT, p_receipt_id TEXT, p_destroyed_at TEXT, p_attestation TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_key TEXT; v_state TEXT; v_op TEXT; v_secret TEXT; v_expected TEXT;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  SELECT key_id, shred_state, shred_op_id INTO v_key, v_state, v_op
    FROM public.item_key_control WHERE item_id = p_item_id;
  IF v_key IS NULL THEN RETURN false; END IF;
  IF v_state = 'shred_complete' THEN RETURN false; END IF;             -- already done (idempotent)
  IF v_state <> 'shred_pending' OR v_op IS DISTINCT FROM p_shred_op_id THEN
    RAISE EXCEPTION 'forget completion does not match a pending shred';
  END IF;
  IF p_receipt_id ~ E'\n' OR p_destroyed_at ~ E'\n' OR v_key ~ E'\n' THEN
    RAISE EXCEPTION 'attestation field contains a separator';          -- defensive
  END IF;
  SELECT completion_secret INTO v_secret FROM public.crypto_config WHERE id = 1;
  v_expected := encode(public.hmac(v_key || E'\n' || p_receipt_id || E'\n' || p_destroyed_at, v_secret, 'sha256'), 'hex');
  IF p_attestation IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'invalid destruction attestation';                -- forged / mismatched
  END IF;
  UPDATE public.item_key_control
     SET shred_state = 'shred_complete', shredded_at = p_destroyed_at::timestamptz,
         shred_receipt = p_receipt_id, updated_at = now()
   WHERE item_id = p_item_id;
  RETURN true;
END;
$$;

-- Legacy hydration: establish a key lineage + ciphertext for an EXISTING present item that
-- has no lineage (e.g. upgraded from a Phase 1 schema where its plaintext columns were
-- dropped). Does not append ItemAdded (the item is already present).
CREATE OR REPLACE FUNCTION cat_hydrate_legacy_ct(
  p_item_id TEXT, p_op_id TEXT, p_key_id TEXT, p_epoch INTEGER, p_identity_ct BYTEA, p_refs JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE r JSONB;
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  IF EXISTS (SELECT 1 FROM public.aborted_operations WHERE operation_id = p_op_id) THEN
    RAISE EXCEPTION 'operation was aborted';
  END IF;
  PERFORM 1 FROM public.items WHERE id = p_item_id AND present AND NOT forgotten;
  IF NOT FOUND THEN RAISE EXCEPTION 'legacy hydrate requires a present, non-forgotten item'; END IF;
  -- PK conflict here means a lineage already exists -> caller must use updateIdentity instead
  INSERT INTO public.item_key_control (item_id, key_id, cur_epoch, operation_id, shred_state)
  VALUES (p_item_id, p_key_id, p_epoch, p_op_id, 'active');
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

-- Atomically fence an orphaned provisional operation: under the per-item lock, abort it ONLY
-- if it has not committed a lineage. Returns true if it was fenced (caller may now destroy the
-- key), false if it had actually committed (caller should promote instead). Because writers
-- (cat_add_item_ct / cat_restore_ct / cat_hydrate_legacy_ct) take the SAME lock and reject
-- fenced operations, this closes the reconciler-vs-live-writer TOCTOU.
CREATE OR REPLACE FUNCTION cat_abort_provision(p_item_id TEXT, p_op_id TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM public.cat_lock_item(p_item_id);
  IF EXISTS (SELECT 1 FROM public.item_key_control WHERE item_id = p_item_id AND operation_id = p_op_id) THEN
    RETURN false;  -- the operation committed (possibly concurrently); do NOT abort/destroy
  END IF;
  INSERT INTO public.aborted_operations (operation_id) VALUES (p_op_id) ON CONFLICT DO NOTHING;
  RETURN true;     -- fenced; the key is now safe to destroy
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

-- ----------------------------------------------------- publish ledger (Phase 9)

-- Record a LIVE external publish. Identity-free by construction: only the opaque item_id, a target
-- name, the opaque external handle, and the disclosed field NAMES (the table CHECK rejects any value
-- that is not one of title/year/providerRefs). Returns the new ledger row id.
CREATE OR REPLACE FUNCTION cat_publish_record(p_item_id TEXT, p_target TEXT, p_handle TEXT, p_fields TEXT[])
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
  INSERT INTO public.publish_ledger (item_id, target, external_handle, disclosed_fields)
  VALUES (p_item_id, p_target, p_handle, COALESCE(p_fields, '{}'))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Reconciliation: mark every still-'published' ledger row whose item is now FORGOTTEN as
-- 'revoke_pending'. This is how forget drives revocation WITHOUT being modified — forget only flips
-- items.forgotten; this out-of-band step queues the external copies for unpublish. Returns the count.
CREATE OR REPLACE FUNCTION cat_publish_reconcile_forgotten()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE public.publish_ledger l
     SET status = 'revoke_pending', updated_at = now()
   WHERE l.status = 'published'
     AND EXISTS (SELECT 1 FROM public.items i WHERE i.id = l.item_id AND i.forgotten);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Mark a queued row REVOKED after the revoke adapter confirmed unpublish. Only transitions
-- revoke_pending -> revoked. Returns whether it transitioned.
CREATE OR REPLACE FUNCTION cat_publish_mark_revoked(p_id BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE public.publish_ledger SET status = 'revoked', updated_at = now()
   WHERE id = p_id AND status = 'revoke_pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

-- Record a FAILED revoke attempt (adapter could not unpublish): bump attempt_count and KEEP the row
-- revoke_pending so it stays visible + retryable. An unrevoked external copy is never silently dropped.
CREATE OR REPLACE FUNCTION cat_publish_mark_attempt(p_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.publish_ledger SET attempt_count = attempt_count + 1, updated_at = now()
   WHERE id = p_id AND status = 'revoke_pending';
END;
$$;

-- --------------------------------------------- publish-intent outbox (Phase 12)

-- Record a DURABLE publish intent BEFORE any external side effect. Identity-free: opaque item_id, a
-- target, the disclosed field NAMES, and an opaque correlation_token (the recovery key — the external
-- collection is tagged with the same token). Returns the new intent id. Status starts 'planned'.
CREATE OR REPLACE FUNCTION cat_publish_plan(p_item_id TEXT, p_target TEXT, p_token TEXT, p_fields TEXT[])
RETURNS BIGINT LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
  IF p_token IS NULL OR length(btrim(p_token)) = 0 THEN RAISE EXCEPTION 'publish intent requires a correlation token'; END IF;
  INSERT INTO public.publish_ledger (item_id, target, correlation_token, disclosed_fields, status)
  VALUES (p_item_id, p_target, p_token, COALESCE(p_fields, '{}'), 'planned')
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Per-intent advisory lock (xact-scoped): serializes reconcilers so a single intent is acted on once
-- (no duplicate external creates). Distinct hash namespace from cat_lock_item.
CREATE OR REPLACE FUNCTION cat_publish_lock_intent(p_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('publish_intent:' || p_id::text, 0));
END;
$$;

-- Mark an intent in_flight (bumping attempt_count) just before the external create. Only from a
-- retry-eligible state. Returns whether it transitioned.
CREATE OR REPLACE FUNCTION cat_publish_mark_in_flight(p_id BIGINT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  UPDATE public.publish_ledger SET status = 'in_flight', attempt_count = attempt_count + 1, updated_at = now()
   WHERE id = p_id AND status IN ('planned', 'ambiguous', 'failed');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

-- Mark an in_flight intent AMBIGUOUS (create sent, outcome unknown). Durable — recovery is by token.
CREATE OR REPLACE FUNCTION cat_publish_mark_ambiguous(p_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.publish_ledger SET status = 'ambiguous', updated_at = now()
   WHERE id = p_id AND status = 'in_flight';
END;
$$;

-- Capture the external handle and settle the intent to 'published' (a revocable Phase 9 tombstone).
-- Only from a non-terminal intent state; requires a non-empty handle. Returns whether it settled.
CREATE OR REPLACE FUNCTION cat_publish_settle(p_id BIGINT, p_handle TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE n INTEGER;
BEGIN
  IF p_handle IS NULL OR length(btrim(p_handle)) = 0 THEN RAISE EXCEPTION 'settle requires a non-empty external handle'; END IF;
  UPDATE public.publish_ledger SET external_handle = p_handle, status = 'published', updated_at = now()
   WHERE id = p_id AND status IN ('planned', 'in_flight', 'ambiguous');
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

-- Mark an intent FAILED (retryable/terminal — bounded by the reconciler). Bumps attempt_count.
CREATE OR REPLACE FUNCTION cat_publish_mark_failed(p_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.publish_ledger SET status = 'failed', updated_at = now()
   WHERE id = p_id AND status IN ('planned', 'in_flight', 'ambiguous');
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
REVOKE ALL ON crypto_config FROM PUBLIC;
REVOKE ALL ON crypto_config FROM app;   -- the completion secret is never app-readable
REVOKE ALL ON aborted_operations FROM PUBLIC;
REVOKE ALL ON aborted_operations FROM app;  -- written only via the SECURITY DEFINER fence
REVOKE ALL ON schema_meta FROM PUBLIC;
REVOKE ALL ON schema_meta FROM app;         -- migration version is owner-only (not app-readable)
REVOKE ALL ON publish_ledger FROM PUBLIC;
REVOKE ALL ON publish_ledger FROM app;      -- owner-managed; app mutates ONLY via cat_publish_* fns
GRANT USAGE ON SCHEMA public TO app;
GRANT SELECT ON events, items, provider_refs, item_key_control TO app;
GRANT SELECT ON publish_ledger TO app;      -- identity-free; app/ops read it for reconcile + reporting

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
  cat_hydrate_legacy_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_forget_begin(TEXT),
  cat_forget_complete(TEXT, TEXT, TEXT, TEXT, TEXT),
  cat_abort_provision(TEXT, TEXT),
  cat_record_signal(TEXT, INTEGER, BIGINT),
  cat_rebuild(TIMESTAMPTZ),
  cat_prune_and_rebuild(TIMESTAMPTZ),
  cat_publish_record(TEXT, TEXT, TEXT, TEXT[]),
  cat_publish_reconcile_forgotten(),
  cat_publish_mark_revoked(BIGINT),
  cat_publish_mark_attempt(BIGINT),
  cat_publish_plan(TEXT, TEXT, TEXT, TEXT[]),
  cat_publish_lock_intent(BIGINT),
  cat_publish_mark_in_flight(BIGINT),
  cat_publish_mark_ambiguous(BIGINT),
  cat_publish_settle(BIGINT, TEXT),
  cat_publish_mark_failed(BIGINT),
  set_completion_secret(TEXT),
  set_schema_version(INTEGER)
FROM PUBLIC;
REVOKE ALL ON FUNCTION set_completion_secret(TEXT) FROM app;  -- app can never set the secret
REVOKE ALL ON FUNCTION set_schema_version(INTEGER) FROM app;  -- migration version is owner-only

-- App gets the ciphertext command surface + maintenance. NOT cat_apply (raw lifecycle would
-- bypass key-control/crypto-shred) and NOT the internal helpers.
GRANT EXECUTE ON FUNCTION
  cat_add_item_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_update_identity_ct(TEXT, BYTEA, JSONB),
  cat_restore_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_hydrate_legacy_ct(TEXT, TEXT, TEXT, INTEGER, BYTEA, JSONB),
  cat_forget_begin(TEXT),
  cat_forget_complete(TEXT, TEXT, TEXT, TEXT, TEXT),
  cat_abort_provision(TEXT, TEXT),
  cat_record_signal(TEXT, INTEGER, BIGINT),
  cat_rebuild(TIMESTAMPTZ),
  cat_prune_and_rebuild(TIMESTAMPTZ),
  cat_publish_record(TEXT, TEXT, TEXT, TEXT[]),
  cat_publish_reconcile_forgotten(),
  cat_publish_mark_revoked(BIGINT),
  cat_publish_mark_attempt(BIGINT),
  cat_publish_plan(TEXT, TEXT, TEXT, TEXT[]),
  cat_publish_lock_intent(BIGINT),
  cat_publish_mark_in_flight(BIGINT),
  cat_publish_mark_ambiguous(BIGINT),
  cat_publish_settle(BIGINT, TEXT),
  cat_publish_mark_failed(BIGINT)
TO app;
