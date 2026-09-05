-- Grant nova_anon full access to mesh table
GRANT ALL ON nova_mesh_nodes TO nova_anon;
GRANT USAGE ON SCHEMA public TO nova_anon;

-- Notify PostgREST to reload schema cache
NOTIFY pgrst, 'reload schema';
