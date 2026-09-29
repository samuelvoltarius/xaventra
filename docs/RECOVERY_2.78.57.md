# 2.78.57 capture and native update recovery

Screenshot requests retain the actual redacted tool failure instead of hiding a
policy denial behind generic no-image text. This does not authorize a denied
call. Follow [capture enrollment](SCREENSHOT_DELIVERY.md): exact capture tool,
channel and principal; independent role authorization; authenticated local
session adapter; explicit unlocked session; recipient-bound Telegram delivery.
Do not broadly allow remote desktop control, change a request's channel or
substitute a manually captured image. A missing/locked session remains a failure.

The native package builder preserves approved executable modes and materializes
only declared dependency bin entrypoints in disposable staging. The unused
Windows Tint package is removed; Playwright remains the browser provider.
Public dependency Git metadata is accepted by a narrow allowlist; `.git`, Git
credentials/config, environment files, runtime configuration, private memory and
key files are still refused. Path checks supplement, not replace, secret scans.

Preserve failed package reports and partial archives. Never sign or install a
partial output, delete uncertain activation receipts, or rerun ambiguous state
copy/switch operations. Use a new output location when requalifying a retained
build. The native controller components require independently verified protected
enrollment, writer fencing, snapshot integrity and rollback authority before
production use. See [native update integration](NATIVE_UPDATE_DRIVER.md).

No native production rollout follows merely from this source release or its
Docker publisher. Keep the last verified program, unit, runtime state and
recovery evidence; do not start an old channel-owning container beside a native
service. Signed publisher identity, actual installation and update/rollback,
and real Telegram acceptance remain separate gates. This is not an RC clearance.
