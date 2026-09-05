# Run Xaventra locally

You need Node.js 22 or newer, npm, Git and a local or cloud model endpoint.

```bash
git clone https://github.com/samuelvoltarius/xaventra.git
cd xaventra
npm ci --ignore-scripts
npm run build
cp nova.config.example.json nova.config.json
cp .env.example .env
npm run cli -- setup
npm run start:fast
```

In PowerShell, use `Copy-Item` instead of `cp`. Set the appropriate API key in
your local `.env` for cloud inference. For local inference, select `local` or
`ollama` and run a compatible model server. The example has no active Mesh peers
or channels; no external coordinator is required for one instance.

The setup wizard preserves existing configuration. Telegram is optional. If
enabled, configure the bot token and allowed user IDs before using it.

`--ignore-scripts` installs the reproducible JavaScript dependency graph without
executing dependency installers. Browser automation, native Doctor inference
and Electron may need their platform installers separately. The main README
also supports `npm install` when those dependency scripts are desired.

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
