# Platform installation and verification

The Core is a Node.js application, not a Linux shell script. `install.ps1`
(Windows) and `install.sh` (Linux/macOS/WSL) call the same `scripts/setup.mjs`.
Run them from a trusted clone of this repository. Node.js 22+ and npm must
already be installed. No administrator permission is required for Core setup.

| Action | Windows PowerShell | Linux / macOS / WSL |
|---|---|---|
| Check prerequisites without writes | `./install.ps1 -Check` | `sh install.sh --check` |
| Install and compile Core | `./install.ps1` | `sh install.sh` |
| Include Desktop | `./install.ps1 -Desktop` | `sh install.sh --desktop` |
| Include Chromium | `./install.ps1 -Browser` | `sh install.sh --browser` |
| Allow native dependency installers | `./install.ps1 -Native` | `sh install.sh --native` |
| Configure provider | `npm run cli -- setup` | `npm run cli -- setup` |
| Start Core | `npm start` | `npm start` |

The shell-independent alternative is `node scripts/setup.mjs` with the Unix-style
flags. This also avoids changing PowerShell execution policy. Missing prerequisites
or failed commands stop setup with a nonzero exit; a compiled Core is not falsely
reported as an authenticated provider or a running daemon.

Existing `.env`, OAuth state, facts and either configuration filename are
preserved. New configuration has no active peers, relay, messaging channels,
external MCP servers or automatic update targets. The random API token stays
local. Enabling Telegram requires configuring credentials/allowed users and
removing the install-time disable flags deliberately.

## What is platform-specific?

- Browser automation needs Chromium and, on Linux, compatible system libraries.
- Local Doctor inference depends on supported native binaries, GPU drivers and
  hardware. A CI source build does not validate CUDA, Vulkan or every GPU.
- Desktop packaging needs Electron and OS-specific packaging/signing tools.
  Building TypeScript or testing the IPC bridge is not an installed-app smoke test.
- Core startup supervision is separate: Windows Scheduled Tasks, macOS launchd,
  Linux systemd/PM2 or Docker must be configured and tested on the target host.
- Linux ARM64 and NAS Docker profiles exist but are not equivalent to every NAS,
  ARM board or operating-system version being verified.

The GitHub CI matrix runs isolated Core tests, build, catalogs, assurance and
Desktop bridge tests on its named Windows/Linux/macOS runners. Consult its
actual result and [release evidence](VERIFICATION_2.78.0.md), not a blanket
"runs everywhere" claim. Production node migration remains a separate gate.
