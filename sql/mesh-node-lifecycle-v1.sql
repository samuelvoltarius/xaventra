BEGIN;

ALTER TABLE public.nova_mesh_nodes
  ADD COLUMN IF NOT EXISTS lifecycle_state TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS lifecycle_changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tombstoned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS tombstone_reason TEXT,
  ADD COLUMN IF NOT EXISTS superseded_by TEXT;

ALTER TABLE public.nova_mesh_nodes
  DROP CONSTRAINT IF EXISTS nova_mesh_nodes_lifecycle_state_check;
ALTER TABLE public.nova_mesh_nodes
  ADD CONSTRAINT nova_mesh_nodes_lifecycle_state_check
  CHECK (lifecycle_state IN ('active', 'offline', 'retired', 'tombstoned'));

CREATE INDEX IF NOT EXISTS nova_mesh_nodes_lifecycle_idx
  ON public.nova_mesh_nodes (lifecycle_state, last_heartbeat DESC);

UPDATE public.nova_mesh_nodes
SET lifecycle_state = 'retired', lifecycle_changed_at = CURRENT_TIMESTAMP,
    retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP), status = 'offline'
WHERE lifecycle_state NOT IN ('retired', 'tombstoned')
  AND last_heartbeat < CURRENT_TIMESTAMP - INTERVAL '7 days';

UPDATE public.nova_mesh_nodes
SET lifecycle_state = 'tombstoned', lifecycle_changed_at = CURRENT_TIMESTAMP,
    tombstoned_at = COALESCE(tombstoned_at, CURRENT_TIMESTAMP),
    tombstone_reason = 'Legacy duplicate identity for the Windows main node',
    superseded_by = 'nova-workstation', status = 'offline'
WHERE node_id = 'nova-98d8d3ad';

UPDATE public.nova_mesh_nodes
SET lifecycle_state = 'retired', lifecycle_changed_at = CURRENT_TIMESTAMP,
    retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP),
    tombstone_reason = 'Relay-only infrastructure; not a Nova worker node', status = 'offline'
WHERE node_id = 'nova-29ff4dcf';

UPDATE public.nova_mesh_nodes
SET lifecycle_state = 'retired', lifecycle_changed_at = CURRENT_TIMESTAMP,
    retired_at = COALESCE(retired_at, CURRENT_TIMESTAMP),
    tombstone_reason = 'Historical Nova installation; worker not currently authorized', status = 'offline'
WHERE node_id = 'nova-retired-node';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.nova_mesh_nodes TO nova_anon, nova_admin;
NOTIFY pgrst, 'reload schema';

COMMIT;
