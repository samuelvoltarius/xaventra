#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function findNpmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')]
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'))
    try { candidates.push(realpathSync(join(directory, 'npm'))) } catch { }
  }
  const found = candidates.find(path => path && /npm-cli\.js$/i.test(path) && existsSync(path))
  if (!found) throw new Error('npm was not found. Install Node.js 22+ with npm, reopen the terminal, and retry.')
  return found
}

export function seedConfiguration(directory = root) {
  const canonical = join(directory, 'xaventra.config.json')
  const legacy = join(directory, 'nova.config.json')
  let configPath = existsSync(canonical) ? canonical : existsSync(legacy) ? legacy : canonical
  if (!existsSync(configPath)) {
    const config = JSON.parse(readFileSync(join(root, 'xaventra.config.example.json'), 'utf8'))
    // A new install must not discover example infrastructure or start channels.
    config.mesh.update.nodes = []
    config.mesh.coordination.witnesses = []
    config.mcp.servers = []
    config.server = { enabled: false, host: '127.0.0.1', port: 18789 }
    // 2.85 first start: no cloud provider without a key. The first start finds a
    // local model itself (Doctor + self-setup) instead of asking for one.
    config.provider = 'local'
    config.model = 'auto'
    config.fallbackModels = []
    if (config.channels?.telegram) config.channels.telegram.allowFrom = []
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    // Only a configuration created here starts in first-start mode; an existing
    // installation never gets an onboarding marker.
    const dataDir = join(directory, '.nova-data')
    mkdirSync(dataDir, { recursive: true })
    const marker = join(dataDir, 'onboarding.json')
    if (!existsSync(marker)) writeFileSync(marker,
      `${JSON.stringify({ version: 1, state: 'pending', seededAt: new Date().toISOString() }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  // Validate, but never overwrite a user's existing configuration or credentials.
  JSON.parse(readFileSync(configPath, 'utf8'))
  const envPath = join(directory, '.env')
  if (!existsSync(envPath)) writeFileSync(envPath,
    `# Local credentials; never commit this file.\nNOVA_API_TOKEN=${randomBytes(32).toString('hex')}\nNOVA_DESKTOP_API_TOKEN=${randomBytes(32).toString('hex')}\nNOVA_TELEGRAM_MODE=disabled\nNOVA_NO_TELEGRAM=true\nNOVA_OTEL_ENABLED=false\n`,
    { flag: 'wx', mode: 0o600 })
  return configPath
}

// Optional full workstation desktop (Linux only). The workstation service runs a
// complete XFCE session when these two programs exist, otherwise its minimal
// openbox desktop (src/host/workstation-desktop.ts). Packages as installed and
// verified on the Spark on 2026-09-30.
export const WORKSTATION_DESKTOP_PACKAGES = ['xfce4', 'xfce4-terminal', 'thunar', 'dbus-x11']
export const WORKSTATION_DESKTOP_PROGRAMS = ['/usr/bin/xfce4-session', '/usr/bin/dbus-run-session']
export const WORKSTATION_DESKTOP_QUESTION = 'Install the full workstation desktop for computer use (XFCE, ~300 MB)? [y/N] '

/** Pure decision: what the installer would do for the workstation desktop. */
export function planWorkstationDesktop({ platform = process.platform, isRoot = process.getuid?.() === 0, exists = existsSync } = {}) {
  if (platform !== 'linux') return { action: 'skip', reason: 'The workstation desktop is only available on Linux.' }
  if (WORKSTATION_DESKTOP_PROGRAMS.every(path => exists(path))) return { action: 'present', reason: 'XFCE workstation desktop is already installed.' }
  const manual = `apt-get install -y --no-install-recommends ${WORKSTATION_DESKTOP_PACKAGES.join(' ')}`
  if (!exists('/usr/bin/apt-get')) return { action: 'unsupported', reason: `No apt-get found. Install XFCE and dbus-run-session with your package manager (Debian/Ubuntu: ${manual}).` }
  const install = ['apt-get', 'install', '-y', '--no-install-recommends', ...WORKSTATION_DESKTOP_PACKAGES]
  if (isRoot) return { action: 'install', command: install }
  if (!exists('/usr/bin/sudo')) return { action: 'unsupported', reason: `Root rights are needed. Run as root: ${manual}` }
  return { action: 'install', command: ['sudo', ...install] }
}

/** 'install' | 'skip' | 'ask' — explicit flags win; only an interactive Linux terminal is asked. */
export function resolveWorkstationDesktopChoice(args, { platform = process.platform, interactive = false } = {}) {
  if (args.includes('--workstation-desktop') && args.includes('--no-workstation-desktop'))
    throw new Error('Choose either --workstation-desktop or --no-workstation-desktop.')
  if (args.includes('--workstation-desktop')) return 'install'
  if (args.includes('--no-workstation-desktop') || platform !== 'linux' || !interactive) return 'skip'
  if (args.includes('--check') || args.includes('--configure-only')) return 'skip'
  return 'ask'
}

export function acceptsYes(answer) { return /^\s*(y|yes|j|ja)\s*$/i.test(answer || '') }

async function askWorkstationDesktop() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return acceptsYes(await rl.question(WORKSTATION_DESKTOP_QUESTION)) } finally { rl.close() }
}

function installWorkstationDesktop(plan) {
  if (plan.action !== 'install') { console.log(plan.reason); if (plan.action === 'unsupported') throw new Error('Setup stopped: workstation desktop not installed.'); return }
  console.log(`Installing workstation desktop: ${plan.command.join(' ')}`)
  const result = spawnSync(plan.command[0], plan.command.slice(1), { stdio: 'inherit' })
  if (result.error || result.status !== 0)
    throw new Error(`Setup stopped: ${plan.command.join(' ')} failed (package lists stale? run apt-get update first). ${result.error?.message || ''}`)
  if (!WORKSTATION_DESKTOP_PROGRAMS.every(path => existsSync(path))) throw new Error('Setup stopped: XFCE packages installed, but xfce4-session or dbus-run-session is still missing.')
  console.log('Workstation desktop installed. Restart xaventra-workstation to switch from the minimal desktop to XFCE.')
}

export async function main(args = process.argv.slice(2)) {
  const supported = new Set(['--check', '--configure-only', '--desktop', '--browser', '--native', '--workstation-desktop', '--no-workstation-desktop'])
  if (args.some(arg => !supported.has(arg))) throw new Error(`Options: ${[...supported].join(', ')}`)
  let workstationDesktop = resolveWorkstationDesktopChoice(args, { interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) })
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Xaventra requires Node.js 22 or newer.')
  const npm = findNpmCli()
  console.log(`Xaventra setup: ${process.platform}/${process.arch}, Node ${process.versions.node}`)
  if (args.includes('--check')) {
    if (workstationDesktop === 'install') { const plan = planWorkstationDesktop(); console.log(`Workstation desktop: ${plan.command ? plan.command.join(' ') : plan.reason}`) }
    console.log('Prerequisites OK (no files changed; no model or runtime claim).'); return
  }
  const configPath = seedConfiguration()
  if (args.includes('--configure-only')) { console.log(`Configuration ready: ${configPath}`); return }
  function runNpm(command) {
    const result = spawnSync(process.execPath, [npm, ...command], { cwd: root, stdio: 'inherit', windowsHide: true })
    if (result.error || result.status !== 0) throw new Error(`Setup stopped: npm ${command.join(' ')} failed. ${result.error?.message || ''}`)
  }
  runNpm(['ci', ...(args.includes('--native') ? [] : ['--ignore-scripts'])])
  runNpm(['run', 'build'])
  runNpm(['run', 'typecheck'])
  if (args.includes('--browser')) runNpm(['exec', '--', 'playwright', 'install', 'chromium'])
  if (args.includes('--desktop')) runNpm(['ci', '--prefix', 'desktop'])
  if (workstationDesktop === 'ask' && planWorkstationDesktop().action === 'install') workstationDesktop = (await askWorkstationDesktop()) ? 'install' : 'skip'
  if (workstationDesktop === 'install') installWorkstationDesktop(planWorkstationDesktop())
  console.log('Core installed and compiled. Next: npm run start:fast, then open the Desktop app.')
  console.log('The first start sets itself up: it checks this computer, looks for a local model and asks at most three questions in the Desktop app.')
  console.log('Channels stay disabled until you connect them. The terminal wizard (npm run cli -- setup) remains available.')
  console.log('No service, firewall rule, model download or production deployment was created.')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
