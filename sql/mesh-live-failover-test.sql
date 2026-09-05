BEGIN;

DO $$
DECLARE
    v_suffix TEXT := substr(md5(random()::TEXT), 1, 8);
    v_service TEXT;
    v_task_id TEXT;
    v_takeover_service TEXT;
    v_a TEXT;
    v_b TEXT;
    v_c TEXT;
    v_first JSONB;
    v_blocked JSONB;
    v_takeover JSONB;
    v_task_lease_b JSONB;
    v_task_lease_c JSONB;
    v_recovery_lease JSONB;
    v_token_b TEXT;
    v_token_c TEXT;
    v_recovery_token TEXT;
    v_claim JSONB;
    v_count INTEGER;
BEGIN
    v_service := 'live-failover:' || v_suffix;
    v_task_id := 'live-failover-task-' || v_suffix;
    v_takeover_service := 'live-failover-takeover:' || v_suffix;
    v_a := 'node-a-' || v_suffix;
    v_b := 'node-b-' || v_suffix;
    v_c := 'node-c-' || v_suffix;

    v_first := public.nova_acquire_service_lease(v_service, v_a, v_a, 1000);
    v_blocked := public.nova_acquire_service_lease(v_service, v_b, v_b, 1000);
    IF NOT (v_first->>'leader')::BOOLEAN OR (v_blocked->>'leader')::BOOLEAN THEN
        RAISE EXCEPTION 'two leaders admitted before lease expiry';
    END IF;
    PERFORM pg_sleep(1.1);
    v_takeover := public.nova_acquire_service_lease(v_service, v_b, v_b, 1000);
    IF NOT (v_takeover->>'leader')::BOOLEAN OR (v_takeover->>'epoch')::BIGINT <= (v_first->>'epoch')::BIGINT THEN
        RAISE EXCEPTION 'takeover failed to advance epoch';
    END IF;

    INSERT INTO public.nova_mesh_tasks(id, from_node, to_node, task, status, created_at, idempotency_key)
    VALUES (v_task_id, 'live-test', v_b, 'live fencing test', 'pending', (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT, v_task_id);
    v_task_lease_b := public.nova_acquire_service_lease('mesh-task:' || v_task_id, v_b, v_b, 1000);
    v_token_b := 'mesh-task:' || v_task_id || ':' || (v_task_lease_b->>'epoch') || ':' || v_b;
    v_claim := public.nova_claim_mesh_task(v_task_id, v_b, v_token_b, (v_task_lease_b->>'epoch')::BIGINT);
    IF v_claim IS NULL THEN RAISE EXCEPTION 'first worker could not claim task'; END IF;

    PERFORM pg_sleep(1.1);
    v_recovery_lease := public.nova_acquire_service_lease(v_takeover_service, v_c, v_c, 5000);
    v_recovery_token := v_takeover_service || ':' || (v_recovery_lease->>'epoch') || ':' || v_c;
    SELECT count(*) INTO v_count FROM public.nova_recover_stale_mesh_tasks(
        v_c, v_recovery_token, (v_recovery_lease->>'epoch')::BIGINT,
        (extract(epoch FROM clock_timestamp()) * 1000)::BIGINT + 1, v_takeover_service
    ) WHERE id = v_task_id;
    IF v_count <> 1 THEN RAISE EXCEPTION 'stale task recovery failed'; END IF;

    v_task_lease_c := public.nova_acquire_service_lease('mesh-task:' || v_task_id, v_c, v_c, 5000);
    v_token_c := 'mesh-task:' || v_task_id || ':' || (v_task_lease_c->>'epoch') || ':' || v_c;
    v_claim := public.nova_claim_mesh_task(v_task_id, v_c, v_token_c, (v_task_lease_c->>'epoch')::BIGINT);
    IF v_claim IS NULL THEN RAISE EXCEPTION 'takeover worker could not claim task'; END IF;
    IF public.nova_finish_mesh_task(v_task_id, v_b, v_token_b, 'done', 'stale') THEN
        RAISE EXCEPTION 'stale worker write was accepted';
    END IF;
    IF NOT public.nova_finish_mesh_task(v_task_id, v_c, v_token_c, 'done', 'current') THEN
        RAISE EXCEPTION 'current worker write was rejected';
    END IF;

    RAISE NOTICE 'PASS: one leader, epoch takeover, single task claim, stale worker fenced';
END;
$$;

ROLLBACK;
