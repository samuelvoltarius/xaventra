# Run Xaventra locally

You need Node.js 22 or newer, npm, Git and a local or cloud model endpoint.

```bash
git clone https://github.com/samuelvoltarius/xaventra.git
cd xaventra
sh install.sh
npm run cli -- setup
npm run start:fast
```

On native Windows, run `./install.ps1` instead of `sh install.sh`; alternatively
use `node scripts/setup.mjs` on any supported OS. Set the appropriate API key in
your local `.env` for cloud inference. For local inference, select `local` or
`ollama` and run a compatible model server. The example has no active Mesh peers
or channels; no external coordinator is required for one instance.

The setup wizard preserves existing configuration. Telegram is optional. If
enabled, configure the bot token and allowed user IDs before using it.

The default installer uses `npm ci --ignore-scripts`. Browser automation,
native Doctor inference and Electron are optional: use `--browser`, `--native`
and `--desktop` (`-Browser`, `-Native`, `-Desktop` in PowerShell) when needed.
The installer preserves existing configuration and generates a private API token
only for a new `.env`. Do not replace that file with an empty example afterwards.
It does not provision Node itself, services, firewall rules or model weights.

In another terminal, use `npm run cli -- chat`, or start the Desktop client:

```bash
npm run desktop:install
npm run desktop:dev
```

Desktop connects to `http://127.0.0.1:3011` by default. Core must be running and
own its control-plane lease. Use the startup log to verify the actual endpoint.

For process supervision, install PM2 separately and use
`pm2 start ecosystem.config.cjs`. Xaventra schedules its own background work
inside the governed daemon; do not start a second uncoordinated scheduler.

Next: [configuration](CONFIGURATION.md), [Desktop](DESKTOP.md),
[development](DEVELOPMENT.md), [Mesh](MESH.md), [Telegram](TELEGRAM.md).
