# Nova infrastructure worker

This profile runs Nova on an existing server as a resource-limited Mesh worker.

Production invariants:

- `NOVA_NODE_ONLY=true`, `NOVA_NO_TELEGRAM=true`, and `NOVA_TELEGRAM_MODE=disabled`
- `NOVA_MAIN_ELIGIBLE=false`; the node cannot acquire the canonical Main lease
- Direct Mesh listens only on the node's Tailscale address
- Supabase/Relay/HA credentials live in root-owned `.nova.env`, never in the image or config
- Codex OAuth and channel credentials are not copied to the worker
- The root filesystem is read-only; only Nova data, learning, vector, and log volumes are writable
- Releases are activated by the fenced Main through the signed Mesh updater

The compose service and container name intentionally remain `nova-worker` on every host. They are on separate Docker daemons, and the common name lets the typed updater use one fixed service profile.
