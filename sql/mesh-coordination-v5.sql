-- Nova Mesh Coordination v5: fencing (CL-20260929-07)
--
-- Apply AFTER mesh-coordination-v2.sql, v3 and v4, with database-admin access
-- (psql or the admin SQL editor). Idempotent: running it twice is harmless.
-- DO NOT apply from a Nova node; the anon key must not be able to do this.
--
-- What it adds:
--   1. nova_mesh_epoch_seq: ONE strictly monotone source for every lease
--      epoch. A BEFORE trigger assigns nextval() to every inserted lease row,
--      so an epoch can never restart at 1 after a DELETE, a re-created row or
--      a client that tries to supply its own epoch. Updates may never lower an
--      epoch; a holder change always draws a fresh nextval().
--   2. holder_instance_id: the process (not only the node) that holds a lease.
--   3. nova_acquire_service_lease_v2(...): renewal only for the same node AND
--      the same instance while the lease is live; everything else (new holder,
--      other instance, renewal after expiry) is a new term with nextval().
--      Returns server_now and ttl_ms so clients bound their deadline without
--      depending on their own wall clock.
--   4. nova_acquire_service_lease (v1) keeps its signature for rolling
--      upgrades but uses the sequence too. A v1 caller is treated as instance
--      NULL, so an old node can neither reset nor steal a live v2 epoch.
--   5. nova_check_fence(...): read-only (STABLE) live check. Replaces
--      "checking by acquiring".
--   6. nova_fenced_upsert_shared_memory(...): shared-memory write that is
--      linearised against the lease row (FOR SHARE) and only overwrites rows
--      whose writer_epoch is not newer.
--   7. nova_fencing_status(): read-only facts for the readiness gates
--      (fencing-enforced, lease-table-locked).
--   8. Lease table read-only for anon; HA scopes of nova_shared_memory are
--      writable only through the fenced RPC.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Monotone epoch sequence
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS public.nova_mesh_epoch_seq AS BIGINT MINVALUE 1 START WITH 1 NO CYCLE;

-- Never lower the sequence: take max(current sequence position, highest epoch
-- ever stored). Re-running this block only ever moves the sequence forward.
SELECT setval(
    'public.nova_mesh_epoch_seq',
    GREATEST(
        (SELECT COALESCE(MAX(epoch), 1) FROM public.nova_mesh_leases),
        (SELECT last_value FROM public.nova_mesh_epoch_seq)
    ),
    true
);

-- ---------------------------------------------------------------------------
-- 2. Process identity and shared-memory writer epoch
-- ---------------------------------------------------------------------------
ALTER TABLE public.nova_mesh_leases
    ADD COLUMN IF NOT EXISTS holder_instance_id TEXT;

ALTER TABLE public.nova_shared_memory
    ADD COLUMN IF NOT EXISTS writer_epoch BIGINT,
    ADD COLUMN IF NOT EXISTS writer_service TEXT;
CREATE INDEX IF NOT EXISTS idx_nova_shared_memory_scope_epoch
    ON public.nova_shared_memory(scope, writer_epoch DESC NULLS LAST, timestamp DESC);

-- Trigger: every INSERT draws nextval(); an UPDATE never lowers the epoch and a
-- holder/instance change always draws nextval(). This holds for RPCs, for the
-- admin UI and for any legacy client alike.
CREATE OR REPLACE FUNCTION public.nova_mesh_leases_epoch_guard() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.epoch := nextval('public.nova_mesh_epoch_seq');
        RETURN NEW;
    END IF;
    IF NEW.epoch < OLD.epoch THEN
        RAISE EXCEPTION 'nova_mesh_leases.epoch must never decrease (% -> %)', OLD.epoch, NEW.epoch;
    END IF;
    IF (NEW.holder_node_id IS DISTINCT FROM OLD.holder_node_id
        OR NEW.holder_instance_id IS DISTINCT FROM OLD.holder_instance_id)
       AND NEW.epoch <= OLD.epoch THEN
        NEW.epoch := nextval('public.nova_mesh_epoch_seq');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS nova_mesh_leases_epoch_guard ON public.nova_mesh_leases;
CREATE TRIGGER nova_mesh_leases_epoch_guard
    BEFORE INSERT OR UPDATE ON public.nova_mesh_leases
    FOR EACH ROW EXECUTE FUNCTION public.nova_mesh_leases_epoch_guard();

-- ---------------------------------------------------------------------------
-- 3. Acquire v2 (node + instance)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nova_acquire_service_lease_v2(
    p_service TEXT,
    p_holder_node_id TEXT,
    p_holder_instance_id TEXT,
    p_holder_hostname TEXT,
    p_ttl_ms INTEGER DEFAULT 90000
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lease public.nova_mesh_leases%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    IF p_holder_instance_id IS NULL OR length(p_holder_instance_id) < 8 THEN
        RAISE EXCEPTION 'holder instance id is required';
    END IF;
    p_ttl_ms := greatest(1000, least(COALESCE(p_ttl_ms, 90000), 300000));
    -- epoch in VALUES is a placeholder; the epoch guard trigger assigns
    -- nextval() and EXCLUDED.epoch carries that fresh value.
    INSERT INTO public.nova_mesh_leases AS current (
        service, holder_node_id, holder_instance_id, holder_hostname, lease_ttl_ms,
        acquired_at, updated_at, expires_at, epoch
    ) VALUES (
        p_service, p_holder_node_id, p_holder_instance_id, p_holder_hostname, p_ttl_ms,
        v_now, v_now, v_now + make_interval(secs => p_ttl_ms::DOUBLE PRECISION / 1000.0), 0
    )
    ON CONFLICT (service) DO UPDATE SET
        holder_node_id = EXCLUDED.holder_node_id,
        holder_instance_id = EXCLUDED.holder_instance_id,
        holder_hostname = EXCLUDED.holder_hostname,
        lease_ttl_ms = EXCLUDED.lease_ttl_ms,
        acquired_at = CASE
            WHEN current.holder_node_id = EXCLUDED.holder_node_id
             AND current.holder_instance_id IS NOT DISTINCT FROM EXCLUDED.holder_instance_id
             AND current.expires_at > v_now THEN current.acquired_at
            ELSE v_now
        END,
        updated_at = v_now,
        expires_at = v_now + make_interval(secs => p_ttl_ms::DOUBLE PRECISION / 1000.0),
        -- Same node + same instance + still live = renewal (same term).
        -- Anything else, including renewal after expiry, starts a new term.
        epoch = CASE
            WHEN current.holder_node_id = EXCLUDED.holder_node_id
             AND current.holder_instance_id IS NOT DISTINCT FROM EXCLUDED.holder_instance_id
             AND current.expires_at > v_now THEN current.epoch
            ELSE EXCLUDED.epoch
        END
    WHERE (current.holder_node_id = EXCLUDED.holder_node_id
           AND current.holder_instance_id IS NOT DISTINCT FROM EXCLUDED.holder_instance_id)
       OR current.expires_at <= v_now
    RETURNING * INTO v_lease;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'leader', true,
            'holder_node_id', v_lease.holder_node_id,
            'holder_instance_id', v_lease.holder_instance_id,
            'holder_hostname', v_lease.holder_hostname,
            'epoch', v_lease.epoch,
            'expires_at', v_lease.expires_at,
            'server_now', v_now,
            'ttl_ms', p_ttl_ms,
            'protocol', 'v2',
            'reason', 'lease acquired or renewed (v2)'
        );
    END IF;

    SELECT * INTO v_lease FROM public.nova_mesh_leases WHERE service = p_service;
    RETURN jsonb_build_object(
        'leader', false,
        'holder_node_id', v_lease.holder_node_id,
        'holder_instance_id', v_lease.holder_instance_id,
        'holder_hostname', v_lease.holder_hostname,
        'epoch', v_lease.epoch,
        'expires_at', v_lease.expires_at,
        'server_now', v_now,
        'ttl_ms', p_ttl_ms,
        'protocol', 'v2',
        'reason', 'lease held by another node or process'
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. v1 kept for rolling upgrades, now sequence-backed and instance-aware.
--    A v1 caller has instance NULL: it may renew only a live lease that was
--    itself taken through v1 (instance NULL) on the same node, and it may take
--    over only an expired lease. It can never lower or reuse an epoch.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nova_acquire_service_lease(
    p_service TEXT,
    p_holder_node_id TEXT,
    p_holder_hostname TEXT,
    p_ttl_ms INTEGER DEFAULT 90000
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lease public.nova_mesh_leases%ROWTYPE;
    v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
    p_ttl_ms := greatest(1000, least(COALESCE(p_ttl_ms, 90000), 300000));
    INSERT INTO public.nova_mesh_leases AS current (
        service, holder_node_id, holder_instance_id, holder_hostname, lease_ttl_ms,
        acquired_at, updated_at, expires_at, epoch
    ) VALUES (
        p_service, p_holder_node_id, NULL, p_holder_hostname, p_ttl_ms,
        v_now, v_now, v_now + make_interval(secs => p_ttl_ms::DOUBLE PRECISION / 1000.0), 0
    )
    ON CONFLICT (service) DO UPDATE SET
        holder_node_id = EXCLUDED.holder_node_id,
        holder_instance_id = NULL,
        holder_hostname = EXCLUDED.holder_hostname,
        lease_ttl_ms = EXCLUDED.lease_ttl_ms,
        acquired_at = CASE
            WHEN current.holder_node_id = EXCLUDED.holder_node_id
             AND current.holder_instance_id IS NULL
             AND current.expires_at > v_now THEN current.acquired_at
            ELSE v_now
        END,
        updated_at = v_now,
        expires_at = v_now + make_interval(secs => p_ttl_ms::DOUBLE PRECISION / 1000.0),
        epoch = CASE
            WHEN current.holder_node_id = EXCLUDED.holder_node_id
             AND current.holder_instance_id IS NULL
             AND current.expires_at > v_now THEN current.epoch
            ELSE EXCLUDED.epoch
        END
    WHERE (current.holder_node_id = EXCLUDED.holder_node_id AND current.holder_instance_id IS NULL)
       OR current.expires_at <= v_now
    RETURNING * INTO v_lease;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'leader', true,
            'holder_node_id', v_lease.holder_node_id,
            'holder_hostname', v_lease.holder_hostname,
            'epoch', v_lease.epoch,
            'expires_at', v_lease.expires_at,
            'protocol', 'v1',
            'reason', 'lease acquired or renewed (v1 compatibility)'
        );
    END IF;

    SELECT * INTO v_lease FROM public.nova_mesh_leases WHERE service = p_service;
    RETURN jsonb_build_object(
        'leader', false,
        'holder_node_id', v_lease.holder_node_id,
        'holder_hostname', v_lease.holder_hostname,
        'epoch', v_lease.epoch,
        'expires_at', v_lease.expires_at,
        'protocol', 'v1',
        'reason', 'lease held by another node or process'
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Read-only live fence check (no acquisition, no renewal, no side effect)
--    p_holder_instance_id NULL = check node + epoch only (used by workers
--    that validate a delegated fence; the epoch is globally unique).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nova_check_fence(
    p_service TEXT,
    p_epoch BIGINT,
    p_holder_node_id TEXT,
    p_holder_instance_id TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT jsonb_build_object(
        'valid', COALESCE((
            SELECT l.holder_node_id = p_holder_node_id
               AND l.epoch = p_epoch
               AND l.expires_at > statement_timestamp()
               AND (p_holder_instance_id IS NULL OR l.holder_instance_id IS NOT DISTINCT FROM p_holder_instance_id)
              FROM public.nova_mesh_leases l WHERE l.service = p_service
        ), false),
        'epoch', (SELECT l.epoch FROM public.nova_mesh_leases l WHERE l.service = p_service),
        'holder_node_id', (SELECT l.holder_node_id FROM public.nova_mesh_leases l WHERE l.service = p_service),
        'expires_at', (SELECT l.expires_at FROM public.nova_mesh_leases l WHERE l.service = p_service),
        'server_now', statement_timestamp()
    );
$$;

-- ---------------------------------------------------------------------------
-- 6. Fenced shared-memory upsert
--    FOR SHARE on the lease row blocks a concurrent takeover (which needs a row
--    lock) until this write commits, so the write is linearised against the
--    lease. Rows are only replaced by a writer whose epoch is not older.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nova_fenced_upsert_shared_memory(
    p_fence_service TEXT,
    p_epoch BIGINT,
    p_holder_node_id TEXT,
    p_holder_instance_id TEXT,
    p_row JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_lease public.nova_mesh_leases%ROWTYPE;
    v_written INTEGER := 0;
BEGIN
    IF p_row->>'id' IS NULL OR p_row->>'scope' IS NULL THEN
        RAISE EXCEPTION 'fenced upsert requires id and scope';
    END IF;
    SELECT * INTO v_lease FROM public.nova_mesh_leases WHERE service = p_fence_service FOR SHARE;
    IF NOT FOUND
       OR v_lease.holder_node_id <> p_holder_node_id
       OR v_lease.epoch <> p_epoch
       OR v_lease.holder_instance_id IS DISTINCT FROM p_holder_instance_id
       OR v_lease.expires_at <= clock_timestamp() THEN
        RETURN jsonb_build_object('written', false, 'reason', 'stale_fence', 'current_epoch', v_lease.epoch);
    END IF;

    INSERT INTO public.nova_shared_memory AS existing (
        id, user_id, role, content, timestamp, keywords, source_node, scope, metadata,
        updated_at, writer_epoch, writer_service
    ) VALUES (
        p_row->>'id',
        COALESCE(p_row->>'user_id', 'system'),
        COALESCE(p_row->>'role', 'system'),
        COALESCE(p_row->>'content', ''),
        COALESCE((p_row->>'timestamp')::BIGINT, (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT),
        COALESCE(ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_row->'keywords', '[]'::jsonb))), ARRAY[]::TEXT[]),
        p_row->>'source_node',
        p_row->>'scope',
        COALESCE(p_row->'metadata', '{}'::jsonb),
        clock_timestamp(),
        p_epoch,
        p_fence_service
    )
    ON CONFLICT (id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        role = EXCLUDED.role,
        content = EXCLUDED.content,
        timestamp = EXCLUDED.timestamp,
        keywords = EXCLUDED.keywords,
        source_node = EXCLUDED.source_node,
        scope = EXCLUDED.scope,
        metadata = EXCLUDED.metadata,
        updated_at = EXCLUDED.updated_at,
        writer_epoch = EXCLUDED.writer_epoch,
        writer_service = EXCLUDED.writer_service
    WHERE existing.writer_epoch IS NULL OR existing.writer_epoch <= EXCLUDED.writer_epoch;
    GET DIAGNOSTICS v_written = ROW_COUNT;

    RETURN jsonb_build_object(
        'written', v_written = 1,
        'reason', CASE WHEN v_written = 1 THEN 'written' ELSE 'newer_writer_epoch' END,
        'current_epoch', v_lease.epoch
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Read-only status for readiness gates
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nova_fencing_status() RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_role TEXT;
    v_writable BOOLEAN := false;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['nova_anon', 'anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)
           AND has_table_privilege(v_role, 'public.nova_mesh_leases', 'INSERT,UPDATE,DELETE,TRUNCATE') THEN
            v_writable := true;
        END IF;
    END LOOP;
    RETURN jsonb_build_object(
        'version', 5,
        'epoch_sequence', EXISTS (SELECT 1 FROM pg_class WHERE relname = 'nova_mesh_epoch_seq' AND relkind = 'S'),
        'epoch_guard_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'nova_mesh_leases_epoch_guard' AND NOT tgisinternal),
        'lease_table_anon_writable', v_writable,
        'lease_write_policies', (SELECT count(*) FROM pg_policies
                                 WHERE schemaname = 'public' AND tablename = 'nova_mesh_leases' AND cmd <> 'SELECT')
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. Lock the lease table: anon may read, writes only through SECURITY
--    DEFINER RPCs. HA scopes of nova_shared_memory only through the fenced RPC.
-- ---------------------------------------------------------------------------
ALTER TABLE public.nova_mesh_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON public.nova_mesh_leases;
DROP POLICY IF EXISTS "nova_mesh_leases_read" ON public.nova_mesh_leases;
CREATE POLICY "nova_mesh_leases_read" ON public.nova_mesh_leases FOR SELECT USING (true);

DO $$
DECLARE v_role TEXT;
BEGIN
    FOREACH v_role IN ARRAY ARRAY['nova_anon', 'anon', 'authenticated'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
            EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.nova_mesh_leases FROM %I', v_role);
            EXECUTE format('GRANT SELECT ON public.nova_mesh_leases TO %I', v_role);
        END IF;
    END LOOP;
END;
$$;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.nova_mesh_leases FROM PUBLIC;

-- Fenced HA scopes: written only by nova_fenced_upsert_shared_memory.
ALTER TABLE public.nova_shared_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON public.nova_shared_memory;
DROP POLICY IF EXISTS "nova_shared_memory_read" ON public.nova_shared_memory;
DROP POLICY IF EXISTS "nova_shared_memory_write_unfenced" ON public.nova_shared_memory;
CREATE POLICY "nova_shared_memory_read" ON public.nova_shared_memory FOR SELECT USING (true);
CREATE POLICY "nova_shared_memory_write_unfenced" ON public.nova_shared_memory FOR ALL
    USING (scope NOT IN ('ha-channel-state', 'ha-message-queue', 'outcome-ledger', 'outcome-checkpoint',
                         'codex-continuity', 'native-tool-checkpoint', 'mesh-release-checkpoint'))
    WITH CHECK (scope NOT IN ('ha-channel-state', 'ha-message-queue', 'outcome-ledger', 'outcome-checkpoint',
                              'codex-continuity', 'native-tool-checkpoint', 'mesh-release-checkpoint'));

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.nova_acquire_service_lease_v2(TEXT, TEXT, TEXT, TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nova_check_fence(TEXT, BIGINT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nova_fenced_upsert_shared_memory(TEXT, BIGINT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.nova_fencing_status() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nova_acquire_service_lease_v2(TEXT, TEXT, TEXT, TEXT, INTEGER) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_acquire_service_lease(TEXT, TEXT, TEXT, INTEGER) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_check_fence(TEXT, BIGINT, TEXT, TEXT) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_fenced_upsert_shared_memory(TEXT, BIGINT, TEXT, TEXT, JSONB) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_fencing_status() TO nova_anon, nova_admin;

NOTIFY pgrst, 'reload schema';
COMMIT;

-- ===========================================================================
-- RÜCKWEG auf v4 (nur bei Bedarf, ebenfalls mit Admin-Zugang, in einer
-- Transaktion). Sequenz UND Epoch-Trigger bleiben absichtlich stehen: sie sind
-- mit der v1-RPC aus v2.sql verträglich (INSERT bekommt nextval, ein
-- Halterwechsel zählt current.epoch + 1 weiter), also bleibt die Epoch auch
-- nach dem Rückweg monoton und ein DELETE setzt sie nicht auf 1 zurück.
-- Knoten mit v5-Code fallen automatisch auf die v1-RPC zurück (sichtbare
-- Warnung, Readiness-Gate fencing-enforced = false).
--
--   BEGIN;
--   DROP POLICY IF EXISTS "nova_shared_memory_write_unfenced" ON public.nova_shared_memory;
--   DROP POLICY IF EXISTS "nova_shared_memory_read" ON public.nova_shared_memory;
--   CREATE POLICY "Allow all for anon" ON public.nova_shared_memory FOR ALL USING (true) WITH CHECK (true);
--   DROP POLICY IF EXISTS "nova_mesh_leases_read" ON public.nova_mesh_leases;
--   CREATE POLICY "Allow all for anon" ON public.nova_mesh_leases FOR ALL USING (true) WITH CHECK (true);
--   GRANT INSERT, UPDATE, DELETE ON public.nova_mesh_leases TO nova_anon;
--   DROP FUNCTION IF EXISTS public.nova_acquire_service_lease_v2(TEXT, TEXT, TEXT, TEXT, INTEGER);
--   DROP FUNCTION IF EXISTS public.nova_check_fence(TEXT, BIGINT, TEXT, TEXT);
--   DROP FUNCTION IF EXISTS public.nova_fenced_upsert_shared_memory(TEXT, BIGINT, TEXT, TEXT, JSONB);
--   DROP FUNCTION IF EXISTS public.nova_fencing_status();
--   -- v1-RPC wieder in der Fassung aus sql/mesh-coordination-v2.sql anlegen
--   -- (nur den CREATE OR REPLACE FUNCTION nova_acquire_service_lease-Block).
--   -- Spalten holder_instance_id / writer_epoch / writer_service, die
--   -- Sequenz nova_mesh_epoch_seq und der Trigger nova_mesh_leases_epoch_guard
--   -- bleiben (additiv, stören v4 nicht, halten die Epoch monoton).
--   NOTIFY pgrst, 'reload schema';
--   COMMIT;
-- ===========================================================================
