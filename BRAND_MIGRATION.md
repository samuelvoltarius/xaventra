# Xaventra brand migration

Xaventra is the public product name for the platform previously developed as Nova.

## Compatibility policy

The first public Xaventra release keeps the existing `NOVA_*` environment variables,
`.nova-*` runtime directories, persisted node IDs and lease names as compatibility
contracts. They are implementation identifiers, not the public brand. Renaming them
in place would invalidate deployed node identities, OAuth locations, signed release
receipts and failover state.

New public commands and package names use `xaventra`. Legacy `nova` CLI aliases remain
available for one major release and emit no credential or data migration.

## Public naming

- Product: Xaventra
- Runtime: Xaventra Core
- Desktop client: Xaventra Desktop
- Operator module surface: Xaventra Studio
- Diagnostic subsystem: Xaventra Doctor
- Distributed network: Xaventra Mesh

## Migration sequence

1. Introduce public Xaventra names and compatibility aliases.
2. Ship and validate a signed migration release on existing nodes.
3. Migrate service/container display names only through the fenced updater.
4. Keep persisted node IDs and data paths stable unless an explicit versioned data
   migration supplies backup, rollback and split-brain validation.

