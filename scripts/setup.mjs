#!/usr/bin/env node
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { dirname, delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  // Validate, but never overwrite a user's existing configuration or credentials.
  JSON.parse(readFileSync(configPath, 'utf8'))
  const envPath = join(directory, '.env')
  if (!existsSync(envPath)) writeFileSync(envPath,
    `# Local credentials; never commit this file.\nNOVA_API_TOKEN=${randomBytes(32).toString('hex')}\nNOVA_TELEGRAM_MODE=disabled\nNOVA_NO_TELEGRAM=true\nNOVA_OTEL_ENABLED=false\n`,
    { flag: 'wx', mode: 0o600 })
  return configPath
}

export function main(args = process.argv.slice(2)) {
  const supported = new Set(['--check', '--configure-only', '--desktop', '--browser', '--native'])
  if (args.some(arg => !supported.has(arg))) throw new Error(`Options: ${[...supported].join(', ')}`)
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Xaventra requires Node.js 22 or newer.')
  const npm = findNpmCli()
  console.log(`Xaventra setup: ${process.platform}/${process.arch}, Node ${process.versions.node}`)
  if (args.includes('--check')) { console.log('Prerequisites OK (no files changed; no model or runtime claim).'); return }
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
  console.log('Core installed and compiled. Next: npm run cli -- setup, then npm start.')
  console.log('A reachable LLM is still required. Channels stay disabled until you configure them.')
  console.log('No service, firewall rule, model download or production deployment was created.')
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
