# Nova on Synology DSM

This profile runs Nova as a hardened standby mesh worker in Synology Container
Manager. It may take over Main and Telegram only after obtaining the canonical
transactional leases and fencing tokens. While Spark is healthy, the NAS stays
standby and does not connect Telegram.

Every release must use the same signed, hash-addressed artifact as Spark and
the infrastructure workers. Preserve the NAS-local Mesh identity, Telegram
secret and state volumes during activation; never bake them into an image.

Persistent state lives below `/volume1/docker/nova`. Do not mount the Docker
socket, SSH private keys, or another node's OAuth directory into this worker.

The initial migration must create a new `nova-nas` mesh identity. Portable
memory and validated outcome data may be seeded from another worker, but
instance IDs, leases, fencing state, replay caches, outboxes, runtime discovery
caches, and OAuth credentials must not be cloned.

DSM 7's 4.4 kernel does not expose Docker CPU CFS quotas or PID cgroups. This
profile therefore pins Nova to CPU cores 0-1, applies relative CPU shares, and
keeps the hard 4 GiB memory limit.
