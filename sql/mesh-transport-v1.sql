begin;

create table if not exists public.nova_mesh_envelopes (
  id uuid primary key,
  from_node text not null,
  to_node text not null,
  kind text not null,
  envelope jsonb not null,
  created_at bigint not null,
  expires_at timestamptz not null,
  delivered boolean not null default false,
  delivered_at timestamptz
);

create index if not exists nova_mesh_envelopes_inbox
  on public.nova_mesh_envelopes (to_node, delivered, created_at);
create index if not exists nova_mesh_envelopes_expiry
  on public.nova_mesh_envelopes (expires_at);

alter table public.nova_mesh_envelopes enable row level security;

-- Production should use a dedicated mesh service role. The service key used by
-- Nova bypasses RLS; no anonymous/authenticated policy is intentionally added.
grant select, insert, update, delete on public.nova_mesh_envelopes to nova_admin;
grant select, insert, update, delete on public.nova_mesh_envelopes to service_role;

comment on table public.nova_mesh_envelopes is
  'Signed Nova mesh envelopes for durable offline delivery; payload trust is verified by each receiving node.';

commit;

notify pgrst, 'reload schema';
