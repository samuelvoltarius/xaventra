-- Nova Mesh Coordination v3
-- Server-clock stale task recovery. This avoids cross-node clock skew in HA.

BEGIN;

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
       AND claimed_at < (
           (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT
           - GREATEST(0, p_stale_after_ms)
       )
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
