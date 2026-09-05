-- Nova DB Initialization Script
-- Runs automatically on first Postgres start

-- Create anon role for PostgREST
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'nova_anon') THEN
    CREATE ROLE nova_anon NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO nova_anon;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO nova_anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO nova_anon;

-- Nova: Memory / Learning table
CREATE TABLE IF NOT EXISTS nova_memory (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  node_id     TEXT NOT NULL DEFAULT 'master',
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  embedding   JSONB,
  tags        TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nova_memory_user ON nova_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_nova_memory_key  ON nova_memory(user_id, key);

-- Nova: Tool execution log
CREATE TABLE IF NOT EXISTS nova_tool_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  node_id     TEXT NOT NULL DEFAULT 'master',
  tool        TEXT NOT NULL,
  params      JSONB,
  result      JSONB,
  success     BOOLEAN NOT NULL DEFAULT true,
  latency_ms  INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nova_tool_log_user ON nova_tool_log(user_id);
CREATE INDEX IF NOT EXISTS idx_nova_tool_log_tool ON nova_tool_log(tool);

-- Nova: LLM request log
CREATE TABLE IF NOT EXISTS nova_llm_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  node_id       TEXT NOT NULL DEFAULT 'master',
  model         TEXT NOT NULL,
  provider      TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  latency_ms    INTEGER,
  success       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nova_llm_log_user  ON nova_llm_log(user_id);
CREATE INDEX IF NOT EXISTS idx_nova_llm_log_model ON nova_llm_log(model);

-- Nova: Exclusive-service leases for main-instance failover
CREATE TABLE IF NOT EXISTS nova_mesh_leases (
  service          TEXT PRIMARY KEY,
  holder_node_id   TEXT NOT NULL,
  holder_hostname  TEXT,
  lease_ttl_ms     INTEGER NOT NULL DEFAULT 90000,
  acquired_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at       TIMESTAMPTZ NOT NULL,
  epoch            BIGINT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_nova_mesh_leases_expires ON nova_mesh_leases(expires_at);

CREATE TABLE IF NOT EXISTS nova_mesh_tasks (
  id               TEXT PRIMARY KEY,
  from_node        TEXT NOT NULL,
  to_node          TEXT NOT NULL,
  task             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  result           TEXT,
  created_at       BIGINT NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  owner_node       TEXT,
  claimed_at       BIGINT,
  lease_epoch      BIGINT,
  fencing_token    TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  run_id           TEXT,
  idempotency_key  TEXT
);
CREATE INDEX IF NOT EXISTS idx_nova_mesh_tasks_claim ON nova_mesh_tasks(to_node, status, created_at);
CREATE INDEX IF NOT EXISTS idx_nova_mesh_tasks_takeover ON nova_mesh_tasks(status, claimed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nova_mesh_tasks_idempotency ON nova_mesh_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;

-- Nova: Shared memory mirror across instances
CREATE TABLE IF NOT EXISTS nova_shared_memory (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL,
  role         TEXT NOT NULL,
  content      TEXT NOT NULL,
  timestamp    BIGINT NOT NULL,
  keywords     TEXT[] DEFAULT ARRAY[]::TEXT[],
  source_node  TEXT,
  scope        TEXT NOT NULL DEFAULT 'local-memory',
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nova_shared_memory_user_time ON nova_shared_memory(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nova_shared_memory_scope ON nova_shared_memory(scope);

-- Nova: Reviewable self-improvement queue
CREATE TABLE IF NOT EXISTS nova_improvement_queue (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL,
  source            TEXT NOT NULL,
  priority          TEXT NOT NULL DEFAULT 'info',
  risk              TEXT NOT NULL DEFAULT 'low',
  status            TEXT NOT NULL DEFAULT 'open',
  evidence          JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_actions  JSONB NOT NULL DEFAULT '[]'::jsonb,
  verification      JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_node       TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nova_improvement_status ON nova_improvement_queue(status);
CREATE INDEX IF NOT EXISTS idx_nova_improvement_priority ON nova_improvement_queue(priority);

-- Nova: Mesh node registry
CREATE TABLE IF NOT EXISTS nova_nodes (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  host        TEXT,
  ip          TEXT,
  role        TEXT NOT NULL DEFAULT 'mesh-node',
  runtime     TEXT,
  version     TEXT,
  last_seen   TIMESTAMPTZ,
  status      TEXT NOT NULL DEFAULT 'unknown',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Grant PostgREST anon read on all nova tables
GRANT SELECT ON nova_memory, nova_tool_log, nova_llm_log, nova_mesh_leases, nova_mesh_tasks, nova_shared_memory, nova_improvement_queue, nova_nodes TO nova_anon;

-- Grant nova_admin full access
GRANT ALL ON nova_memory, nova_tool_log, nova_llm_log, nova_mesh_leases, nova_mesh_tasks, nova_shared_memory, nova_improvement_queue, nova_nodes TO nova_admin;

RAISE NOTICE 'Nova DB initialized successfully';
