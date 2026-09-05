# Xaventra Legacy Dashboard

This optional Next.js application is an experimental legacy gateway client.
It is **not** the authoritative Xaventra dashboard. For normal operation use
Xaventra Desktop (`desktop/`) or the Core dashboard (`src/dashboard/`, port 3011).

The legacy client retains a Clawdbot-compatible gateway protocol and independent
local task storage. Local task status is not Execution Kernel evidence. Its
task APIs do not implement Core authentication, fencing or durable mission
resumption. Do not expose this application to other users or the internet, and
do not put production credentials in `NEXT_PUBLIC_*` variables (they are public
browser configuration).

## Local development only

```bash
cd dashboard
npm ci --ignore-scripts
npm run dev
```

The npm development/start commands bind to `127.0.0.1:3000`. Build separately
with `npm run build`. The supplied service worker is handwritten; no Next PWA
plugin is needed. This package is not installed by the Core setup command.

Before using this UI for real operations, replace the legacy gateway/local
task paths with the authenticated Core Desktop API and verify real tool,
principal and mission evidence. Do not simply relabel local tasks as missions.
