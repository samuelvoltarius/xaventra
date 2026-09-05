-- Nova Distributed Learning Hub
-- Run this SQL in your Supabase SQL Editor

-- Create the learning table
CREATE TABLE IF NOT EXISTS nova_learnings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    topic TEXT NOT NULL,
    facts JSONB NOT NULL DEFAULT '[]',
    source_instance TEXT NOT NULL,
    success_count INTEGER DEFAULT 0,
    fail_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for fast topic lookups
CREATE INDEX IF NOT EXISTS idx_nova_learnings_topic ON nova_learnings(topic);

-- Create index for ranking by success
CREATE INDEX IF NOT EXISTS idx_nova_learnings_success ON nova_learnings(success_count DESC);

-- Enable Row Level Security (optional but recommended)
ALTER TABLE nova_learnings ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can read learnings
CREATE POLICY "Anyone can read learnings" ON nova_learnings
    FOR SELECT USING (true);

-- Policy: Anyone can insert new learnings
CREATE POLICY "Anyone can insert learnings" ON nova_learnings
    FOR INSERT WITH CHECK (true);

-- Policy: Anyone can update learnings (for merging)
CREATE POLICY "Anyone can update learnings" ON nova_learnings
    FOR UPDATE USING (true);

-- Function to update timestamp on update
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update timestamp
DROP TRIGGER IF EXISTS nova_learnings_updated_at ON nova_learnings;
CREATE TRIGGER nova_learnings_updated_at
    BEFORE UPDATE ON nova_learnings
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- Add some useful views
CREATE OR REPLACE VIEW nova_learning_stats AS
SELECT 
    COUNT(*) as total_topics,
    SUM(jsonb_array_length(facts)) as total_facts,
    SUM(success_count) as total_successes,
    SUM(fail_count) as total_failures,
    COUNT(DISTINCT source_instance) as unique_instances
FROM nova_learnings;

-- View for top learnings
CREATE OR REPLACE VIEW nova_top_learnings AS
SELECT 
    topic,
    facts,
    success_count,
    fail_count,
    ROUND(success_count::numeric / NULLIF(success_count + fail_count, 0) * 100, 1) as success_rate,
    source_instance,
    created_at
FROM nova_learnings
ORDER BY success_count DESC
LIMIT 20;
