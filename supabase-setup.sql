-- ============================================
-- Nova Learning Hub — Supabase Table Setup
-- Run this in Supabase Studio SQL Editor:
-- http://100.64.0.11:8010 → SQL Editor
-- ============================================

-- 1. Main table: Shared learnings between Nova instances
CREATE TABLE IF NOT EXISTS nova_learnings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    topic TEXT NOT NULL,
    facts JSONB NOT NULL DEFAULT '[]',
    source_instance TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 2. Index for fast topic lookup
CREATE INDEX IF NOT EXISTS idx_nova_learnings_topic ON nova_learnings(topic);

-- 3. Index for ranking by success
CREATE INDEX IF NOT EXISTS idx_nova_learnings_success ON nova_learnings(success_count DESC);

-- 4. Enable Row Level Security (required by Supabase)
ALTER TABLE nova_learnings ENABLE ROW LEVEL SECURITY;

-- 5. Allow anon key to read and write (Nova uses anon key)
CREATE POLICY "Allow all for anon"
    ON nova_learnings
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- 6. Auto-update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_nova_learnings_updated_at
    BEFORE UPDATE ON nova_learnings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- 7. Mesh service leases: one active main instance per exclusive service
CREATE TABLE IF NOT EXISTS nova_mesh_leases (
    service TEXT PRIMARY KEY,
    holder_node_id TEXT NOT NULL,
    holder_hostname TEXT,
    lease_ttl_ms INTEGER NOT NULL DEFAULT 90000,
    acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    epoch BIGINT NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_nova_mesh_leases_expires ON nova_mesh_leases(expires_at);
ALTER TABLE nova_mesh_leases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON nova_mesh_leases;
CREATE POLICY "Allow all for anon"
    ON nova_mesh_leases
    FOR ALL
    USING (true)
    WITH CHECK (true);

CREATE TABLE IF NOT EXISTS nova_mesh_tasks (
    id TEXT PRIMARY KEY,
    from_node TEXT NOT NULL,
    to_node TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    owner_node TEXT,
    claimed_at BIGINT,
    lease_epoch BIGINT,
    fencing_token TEXT,
    attempt INTEGER NOT NULL DEFAULT 0,
    run_id TEXT,
    idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS idx_nova_mesh_tasks_claim ON nova_mesh_tasks(to_node, status, created_at);
CREATE INDEX IF NOT EXISTS idx_nova_mesh_tasks_takeover ON nova_mesh_tasks(status, claimed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_nova_mesh_tasks_idempotency ON nova_mesh_tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
ALTER TABLE nova_mesh_tasks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON nova_mesh_tasks;
CREATE POLICY "Allow all for anon" ON nova_mesh_tasks FOR ALL USING (true) WITH CHECK (true);

-- 8. Shared memory mirror between Nova instances
CREATE TABLE IF NOT EXISTS nova_shared_memory (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    timestamp BIGINT NOT NULL,
    keywords TEXT[] DEFAULT ARRAY[]::TEXT[],
    source_node TEXT,
    scope TEXT NOT NULL DEFAULT 'local-memory',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nova_shared_memory_user_time ON nova_shared_memory(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_nova_shared_memory_scope ON nova_shared_memory(scope);
ALTER TABLE nova_shared_memory ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON nova_shared_memory;
CREATE POLICY "Allow all for anon"
    ON nova_shared_memory
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- 9. Self-doctor improvement queue
CREATE TABLE IF NOT EXISTS nova_improvement_queue (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'info',
    risk TEXT NOT NULL DEFAULT 'low',
    status TEXT NOT NULL DEFAULT 'open',
    evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
    proposed_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
    verification JSONB NOT NULL DEFAULT '{}'::jsonb,
    source_node TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_nova_improvement_status ON nova_improvement_queue(status);
CREATE INDEX IF NOT EXISTS idx_nova_improvement_priority ON nova_improvement_queue(priority);
ALTER TABLE nova_improvement_queue ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all for anon" ON nova_improvement_queue;
CREATE POLICY "Allow all for anon"
    ON nova_improvement_queue
    FOR ALL
    USING (true)
    WITH CHECK (true);

-- ============================================
-- Verify: Run this to check
-- ============================================
-- SELECT * FROM nova_learnings LIMIT 10;
