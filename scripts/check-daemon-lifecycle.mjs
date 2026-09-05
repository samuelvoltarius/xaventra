// Boot and stop the actual compiled daemon in a disposable runtime. No live
// provider, production configuration, messaging account or Mesh peer is used.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = mkdtempSync(join(tmpdir(), 'xaventra-daemon-lifecycle-'))
const version = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version
const token = 'synthetic-isolated-lifecycle-token'
const provider = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json')
  if (req.url.endsWith('/models')) res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }))
  else res.end(JSON.stringify({ id: 'fixture', choices: [{ message: { role: 'assistant', content: 'Fixture response.' }, finish_reason: 'stop' }], usage: { total_tokens: 5 } }))
})
await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
const probe = createServer()
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
const port = probe.address().port
await new Promise(resolve => probe.close(resolve))
const config = JSON.parse(readFileSync(join(source, 'xaventra.config.example.json'), 'utf8'))
config.provider = 'openai'; config.model = 'fixture-model'; config.fallbackModels = []
config.providers = { openai: { enabled: true, apiKey: 'synthetic-fixture-provider', baseUrl: `http://127.0.0.1:${provider.address().port}/v1` } }
config.doctorModel = 'off'; config.internalModel = 'auto'; config.repairModel = 'off'; config.learningModel = 'off'
config.mesh.update.nodes = []; config.mesh.coordination.witnesses = []; config.mcp.servers = []
config.autonomy = { enabled: false, socialCheckIns: false, triggers: { 'dream-cycle': false } }
config.server = { enabled: true, host: '127.0.0.1', port }
writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(config))
writeFileSync(join(root, 'package.json'), JSON.stringify({ version }))
const env = Object.fromEntries(['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP'].map(k => [k, process.env[k]]).filter(([, value]) => value))
Object.assign(env, {
  HOME: root, USERPROFILE: root, APPDATA: join(root, 'appdata'), LOCALAPPDATA: join(root, 'localappdata'),
  CODEX_HOME: join(root, 'codex'), NODE_ENV: 'test', NOVA_TEST_MODE: '1', NOVA_NO_SIDE_EFFECTS: '1',
  NOVA_SKIP_MODEL_RESOLVER_INIT: '1', NOVA_NODE_ONLY: 'true', NOVA_NO_TELEGRAM: 'true',
  NOVA_TELEGRAM_MODE: 'disabled', NOVA_AUTO_START_OLLAMA: '0', NOVA_API_TOKEN: token,
  NOVA_OTEL_ENABLED: 'false', OTEL_SDK_DISABLED: 'true',
})
mkdirSync(env.APPDATA); mkdirSync(env.LOCALAPPDATA)
const log = createWriteStream(join(root, 'daemon.log'))
const daemon = spawn(process.execPath, [join(source, 'dist/daemon.js')], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
daemon.stdout.pipe(log); daemon.stderr.pipe(log)
let spawnError
daemon.on('error', error => { spawnError = error })
const started = Date.now()
const report = { version, platform: process.platform, passed: false,
  scope: 'Compiled daemon boot, authenticated REST status and instance-scoped CLI shutdown. Scripted loopback model; not live LLM, Telegram or distributed failover.', checks: {} }
try {
  let ready = false
  while (Date.now() - started < 120_000) {
    if (spawnError || daemon.exitCode !== null || daemon.signalCode !== null) throw new Error('Daemon exited before readiness')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1000) })
      if (response.ok && existsSync(join(root, '.nova-data', 'daemon-control.json'))) {
        const status = await response.json()
        report.checks.version = status.version === version
        ready = true
        break
      }
    } catch { /* bounded readiness polling */ }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (!ready) throw new Error('Daemon readiness deadline exceeded')
  report.startupMs = Date.now() - started
  report.checks.authenticatedStatus = true
  report.checks.unauthenticatedRejected = (await fetch(`http://127.0.0.1:${port}/v1/status`, { signal: AbortSignal.timeout(1000) })).status === 401
  const stopStarted = Date.now()
  const cli = spawn(process.execPath, [join(source, 'dist/cli.js'), 'stop'], { cwd: root, env, windowsHide: true, stdio: 'ignore' })
  const code = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cli.kill(); reject(new Error('CLI stop deadline exceeded')) }, 30_000)
    cli.once('exit', code => { clearTimeout(timeout); resolve(code) })
    cli.once('error', error => { clearTimeout(timeout); reject(error) })
  })
  report.shutdownMs = Date.now() - stopStarted
  report.checks.cliSucceeded = code === 0
  report.checks.daemonExitedNormally = daemon.exitCode === 0 && daemon.signalCode === null
  report.checks.ownerMarkerRemoved = !existsSync(join(root, '.nova-data', 'daemon-control.json'))
  report.checks.pidMarkerRemoved = !existsSync(join(root, '.nova.pid'))
  report.passed = Object.values(report.checks).every(Boolean)
} catch (error) {
  report.error = error.message
} finally {
  // Only fixture-owned children may be cleaned up after failure. No process search.
  if (daemon.exitCode === null && daemon.signalCode === null && !spawnError) {
    await new Promise(resolve => {
      const timeout = setTimeout(() => { daemon.kill('SIGKILL'); resolve() }, 5000)
      daemon.once('exit', () => { clearTimeout(timeout); resolve() })
      daemon.kill('SIGTERM')
    })
  }
  provider.closeAllConnections()
  await new Promise(resolve => provider.close(resolve))
  log.end()
}
writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify({ ...report, artifactDirectory: root }, null, 2))
process.exitCode = report.passed ? 0 : 1
