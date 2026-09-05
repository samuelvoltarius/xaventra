-- Nova mesh coordination v4: transactional planned leadership handover.
-- Apply after mesh-coordination-v2.sql.

CREATE OR REPLACE FUNCTION public.nova_release_service_lease(
    p_service TEXT,
    p_holder_node_id TEXT,
    p_epoch BIGINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_released BOOLEAN := FALSE;
BEGIN
    UPDATE public.nova_mesh_leases
       SET expires_at = clock_timestamp(), updated_at = clock_timestamp()
     WHERE service = p_service
       AND holder_node_id = p_holder_node_id
       AND epoch = p_epoch
       AND expires_at > clock_timestamp();
    v_released := FOUND;
    RETURN jsonb_build_object(
        'released', v_released,
        'reason', CASE WHEN v_released
            THEN 'lease expired by current fenced holder'
            ELSE 'holder, epoch or live lease did not match'
        END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.nova_release_service_lease(TEXT, TEXT, BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.nova_release_service_lease(TEXT, TEXT, BIGINT) TO nova_anon, nova_admin;

NOTIFY pgrst, 'reload schema';
