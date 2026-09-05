# Nova Pi 5 rollback runtime

The production service is currently disabled after the worker role moved to the
Synology NAS. Keep the retained runtime current for rollback, but do not enable
or start `nova-pi5.service` during an ordinary release unless the operator
explicitly reverses the NAS migration. A staged update is not an active Mesh
receipt and must be reported as such.

The Pi uses the stable node identity `nova-pi5` and runs as the unprivileged
`xaventra` user. The runtime and its production data live under
`/home/xaventra/nova-runtime`; the historical `/home/xaventra/nova-core`
directory is intentionally not reused.

The systemd unit starts in node-only mode, disables channels, and is compatible
with Nova's signed `systemd` mesh-release profile. Releases replace only the
verified `dist/` tree and package metadata. Configuration, identity, memory,
and update backups remain persistent.

The Pi currently has a 32-bit Raspbian userspace despite its ARM64 kernel. The
installer therefore keeps the distribution Node.js installation untouched and
installs a verified official ARM64 Node.js runtime side-by-side under `/opt`.
The matching Debian ARM64 runtime libraries are extracted into a private
sysroot rather than installed into Raspbian's package database. Nova starts via
the fixed `/opt/nova-node-arm64` loader wrapper. This is required by LanceDB's
ARM64 native package without risking the Pi's 32-bit base system.

The worker configuration binds REST to loopback, binds signed Direct Mesh to
the Pi's Tailscale address, and reaches Spark vLLM through its real Tailscale
endpoint. A historical password-based localhost tunnel is not required and
must remain disabled so capability discovery does not report Spark vLLM as a
Pi-local runtime.
