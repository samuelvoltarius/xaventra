GRANT service_role TO nova_admin;
GRANT nova_anon TO nova_admin;
NOTIFY pgrst, 'reload schema';
