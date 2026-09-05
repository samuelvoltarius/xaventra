CREATE TABLE IF NOT EXISTS nova_mesh_nodes (
  node_id TEXT PRIMARY KEY,
  hostname TEXT,
  ip TEXT,
  ssh_port INTEGER DEFAULT 22,
  ssh_user TEXT,
  platform TEXT,
  version TEXT,
  tools_count INTEGER DEFAULT 0,
  status TEXT DEFAULT 'online',
  capabilities JSONB DEFAULT '[]'::jsonb,
  hardware JSONB,
  software JSONB,
  last_heartbeat TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  registered_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  active_mission TEXT,
  lifecycle_state TEXT NOT NULL DEFAULT 'active',
  lifecycle_changed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  retired_at TIMESTAMPTZ,
  tombstoned_at TIMESTAMPTZ,
  tombstone_reason TEXT,
  superseded_by TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE nova_mesh_nodes DROP CONSTRAINT IF EXISTS nova_mesh_nodes_lifecycle_state_check;
ALTER TABLE nova_mesh_nodes ADD CONSTRAINT nova_mesh_nodes_lifecycle_state_check
  CHECK (lifecycle_state IN ('active', 'offline', 'retired', 'tombstoned'));
CREATE INDEX IF NOT EXISTS nova_mesh_nodes_lifecycle_idx
  ON nova_mesh_nodes (lifecycle_state, last_heartbeat DESC);

ALTER TABLE nova_mesh_nodes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mesh_all ON nova_mesh_nodes;
CREATE POLICY mesh_all ON nova_mesh_nodes FOR ALL USING (true) WITH CHECK (true);

-- Roles used by Nova's self-hosted Supabase deployment.
GRANT ALL ON nova_mesh_nodes TO nova_anon;
GRANT ALL ON nova_mesh_nodes TO nova_admin;
