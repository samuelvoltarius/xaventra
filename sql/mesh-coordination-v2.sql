-- Nova Mesh Coordination v2
-- Versioned, additive migration. Apply with psql or the database admin UI.
-- No general-purpose exec_sql RPC is required or recommended.

BEGIN;

ALTER TABLE public.nova_mesh_leases
    ADD COLUMN IF NOT EXISTS epoch BIGINT NOT NULL DEFAULT 1;

ALTER TABLE public.nova_mesh_tasks
    ADD COLUMN IF NOT EXISTS owner_node TEXT,
    ADD COLUMN IF NOT EXISTS claimed_at BIGINT,
    ADD COLUMN IF NOT EXISTS lease_epoch BIGINT,
    ADD COLUMN IF NOT EXISTS fencing_token TEXT,
    ADD COLUMN IF NOT EXISTS attempt INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS run_id TEXT,
    ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_nova_mesh_leases_expires
    ON public.nova_mesh_leases(expires_at);
CREATE INDEX IF NOT EXISTS idx_nova_mesh_tasks_claim
    ON public.nova_mesh_tasks(to_node, status, created_at);
CREATE INDEX IF NOT EXISTS idx_nova_mesh_tasks_takeover
    ON public.nova_mesh_tasks(status, claimed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nova_mesh_tasks_idempotency
    ON public.nova_mesh_tasks(idempotency_key)
    WHERE idempotency_key IS NOT NULL;

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
        service, holder_node_id, holder_hostname, lease_ttl_ms,
        acquired_at, updated_at, expires_at, epoch
    ) VALUES (
        p_service, p_holder_node_id, p_holder_hostname, p_ttl_ms,
        v_now, v_now, v_now + make_interval(secs => p_ttl_ms::DOUBLE PRECISION / 1000.0), 1
    )
    ON CONFLICT (service) DO UPDATE SET
        holder_node_id = EXCLUDED.holder_node_id,
        holder_hostname = EXCLUDED.holder_hostname,
        lease_ttl_ms = EXCLUDED.lease_ttl_ms,
        acquired_at = CASE
            WHEN current.holder_node_id = EXCLUDED.holder_node_id THEN current.acquired_at
            ELSE v_now
        END,
        updated_at = v_now,
        expires_at = v_now + make_interval(secs => p_ttl_ms::DOUBLE PRECISION / 1000.0),
        epoch = CASE
            WHEN current.holder_node_id = EXCLUDED.holder_node_id THEN current.epoch
            ELSE current.epoch + 1
        END
    WHERE current.holder_node_id = EXCLUDED.holder_node_id
       OR current.expires_at <= v_now
    RETURNING * INTO v_lease;

    IF FOUND THEN
        RETURN jsonb_build_object(
            'leader', true,
            'holder_node_id', v_lease.holder_node_id,
            'holder_hostname', v_lease.holder_hostname,
            'epoch', v_lease.epoch,
            'expires_at', v_lease.expires_at,
            'reason', CASE WHEN v_lease.epoch = 1 THEN 'lease acquired' ELSE 'lease acquired or renewed' END
        );
    END IF;

    SELECT * INTO v_lease FROM public.nova_mesh_leases WHERE service = p_service;
    RETURN jsonb_build_object(
        'leader', false,
        'holder_node_id', v_lease.holder_node_id,
        'holder_hostname', v_lease.holder_hostname,
        'epoch', v_lease.epoch,
        'expires_at', v_lease.expires_at,
        'reason', 'lease held by another node'
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.nova_claim_mesh_task(
    p_task_id TEXT,
    p_node_id TEXT,
    p_fencing_token TEXT,
    p_lease_epoch BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_task public.nova_mesh_tasks%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.nova_mesh_leases
         WHERE service = 'mesh-task:' || p_task_id
           AND holder_node_id = p_node_id AND epoch = p_lease_epoch
           AND expires_at > clock_timestamp()
           AND p_fencing_token = service || ':' || epoch::TEXT || ':' || holder_node_id
    ) THEN
        RETURN NULL;
    END IF;
    UPDATE public.nova_mesh_tasks
       SET status = 'running', owner_node = p_node_id, claimed_at = (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT,
           lease_epoch = p_lease_epoch, fencing_token = p_fencing_token, attempt = COALESCE(attempt, 0) + 1,
           updated_at = clock_timestamp()
     WHERE id = p_task_id AND status = 'pending' AND to_node = p_node_id
     RETURNING * INTO v_task;
    RETURN CASE WHEN FOUND THEN to_jsonb(v_task) ELSE NULL END;
END;
$$;

CREATE OR REPLACE FUNCTION public.nova_renew_mesh_task(
    p_task_id TEXT,
    p_node_id TEXT,
    p_fencing_token TEXT
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    WITH renewed AS (
        UPDATE public.nova_mesh_tasks
           SET claimed_at = (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT,
               updated_at = clock_timestamp()
         WHERE id = p_task_id AND status = 'running'
           AND owner_node = p_node_id AND fencing_token = p_fencing_token
         RETURNING 1
    ) SELECT EXISTS(SELECT 1 FROM renewed);
$$;

CREATE OR REPLACE FUNCTION public.nova_finish_mesh_task(
    p_task_id TEXT,
    p_node_id TEXT,
    p_fencing_token TEXT,
    p_status TEXT,
    p_result TEXT DEFAULT NULL
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_status NOT IN ('done', 'failed') THEN
        RAISE EXCEPTION 'invalid terminal task status';
    END IF;
    UPDATE public.nova_mesh_tasks
       SET status = p_status, result = left(COALESCE(p_result, ''), 10000), updated_at = clock_timestamp()
     WHERE id = p_task_id AND status = 'running'
       AND owner_node = p_node_id AND fencing_token = p_fencing_token;
    RETURN FOUND;
END;
$$;

DROP FUNCTION IF EXISTS public.nova_recover_stale_mesh_tasks(TEXT, TEXT, BIGINT, BIGINT);
CREATE OR REPLACE FUNCTION public.nova_recover_stale_mesh_tasks(
    p_node_id TEXT,
    p_fencing_token TEXT,
    p_lease_epoch BIGINT,
    p_stale_before BIGINT,
    p_takeover_service TEXT DEFAULT 'mesh-task-takeover'
) RETURNS SETOF public.nova_mesh_tasks
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.nova_mesh_tasks
       SET status = 'pending', to_node = p_node_id, owner_node = NULL,
           claimed_at = NULL, lease_epoch = p_lease_epoch,
           fencing_token = p_fencing_token, updated_at = clock_timestamp()
     WHERE status = 'running' AND claimed_at < p_stale_before
       AND EXISTS (
           SELECT 1 FROM public.nova_mesh_leases
            WHERE service = p_takeover_service
              AND holder_node_id = p_node_id AND epoch = p_lease_epoch
              AND expires_at > clock_timestamp()
              AND p_fencing_token = service || ':' || epoch::TEXT || ':' || holder_node_id
       )
     RETURNING *;
$$;

GRANT EXECUTE ON FUNCTION public.nova_acquire_service_lease(TEXT, TEXT, TEXT, INTEGER) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_claim_mesh_task(TEXT, TEXT, TEXT, BIGINT) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_renew_mesh_task(TEXT, TEXT, TEXT) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_finish_mesh_task(TEXT, TEXT, TEXT, TEXT, TEXT) TO nova_anon, nova_admin;
GRANT EXECUTE ON FUNCTION public.nova_recover_stale_mesh_tasks(TEXT, TEXT, BIGINT, BIGINT, TEXT) TO nova_anon, nova_admin;

-- Prefer v2 recovery: PostgreSQL calculates the cutoff using its own clock,
-- so clock skew between Main and workers cannot affect task takeover.
CREATE OR REPLACE FUNCTION public.nova_recover_stale_mesh_tasks_v2(
    p_node_id TEXT,
    p_fencing_token TEXT,
    p_lease_epoch BIGINT,
    p_stale_after_ms BIGINT,
    p_takeover_service TEXT DEFAULT 'mesh-task-takeover'
) RETURNS SETOF public.nova_mesh_tasks
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
    UPDATE public.nova_mesh_tasks
       SET status = 'pending', to_node = p_node_id, owner_node = NULL,
           claimed_at = NULL, lease_epoch = p_lease_epoch,
           fencing_token = p_fencing_token, updated_at = clock_timestamp()
     WHERE status = 'running'
       AND claimed_at < ((extract(epoch FROM clock_timestamp()) * 1000)::BIGINT - GREATEST(0, p_stale_after_ms))
       AND EXISTS (
           SELECT 1 FROM public.nova_mesh_leases
            WHERE service = p_takeover_service
              AND holder_node_id = p_node_id AND epoch = p_lease_epoch
              AND expires_at > clock_timestamp()
              AND p_fencing_token = service || ':' || epoch::TEXT || ':' || holder_node_id
       )
     RETURNING *;
$$;
GRANT EXECUTE ON FUNCTION public.nova_recover_stale_mesh_tasks_v2(TEXT, TEXT, BIGINT, BIGINT, TEXT) TO nova_anon, nova_admin;

NOTIFY pgrst, 'reload schema';
COMMIT;
