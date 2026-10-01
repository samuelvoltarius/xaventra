import { execFile } from 'node:child_process'
import { createHash, sign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs'
import { join } from 'node:path'
import { redactSecrets } from '../security/secret-redaction.js'
import { APT_GET, canonicalJson, getInstallCatalog, isSafeArgument, PLACEHOLDERS, type InstallCatalog, type InstallCatalogEntry, type PlaceholderName } from '../install/install-catalog.js'
import { installTicketBytes, TICKET_ID_PATTERN, verifyInstallTicket, type InstallTicket } from '../install/install-ticket.js'
import { claimTicketOnce, writeDurableJson } from '../install/signed-ticket.js'
import { neverListViolation, packageNeverListViolation } from '../install/never-list.js'
import { resourceRefusal } from '../install/resource-guard.js'

// ============================================================================
// Stufe 2 (S2.2/S2.3): privileged catalog executor inside the root host agent
// (xaventra-host.service on the Spark). The hardened main service never
// becomes root: it only sends signed, short-lived tickets for catalog ids.
// Everything is started with execFile (shell:false), with a fixed minimal
// environment (no inherited secrets), after a resource check, with a recorded
// before-state, a verify probe, a computed rollback and a receipt.
// ============================================================================

export interface InstallExecOptions { timeoutMs: number; env: Record<string, string>; uid?: number; gid?: number }
export interface InstallExecResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export interface InstallExecutor { run(file: string, args: string[], options: InstallExecOptions): Promise<InstallExecResult> }
export interface InstallProbe {
    freeBytes(path: string): number | null
    /** percent; undefined = no GPU on this host; null = probe failed */
    gpuUtilization(): Promise<number | null | undefined>
}
export interface HostInstallerOptions {
    nodeId: string
    clientId: string
    stateDir: string
    ticketPublicKey: string
    receiptPrivateKey?: string
    catalog?: InstallCatalog
    paths?: Partial<Record<Exclude<PlaceholderName, 'nodeLlamaCppVersion'>, string>>
    serviceUser?: { uid: number; gid: number; home: string }
    platform?: string
    arch?: string
    gpuVendor?: 'nvidia' | 'none'
    modelOnly?: boolean
    diskPath?: string
    catalogSigned?: boolean
    now?: () => number
}
export interface InstallStepRecord { argv: string[]; code: number; ms: number; output?: string }
export interface InstallReceipt {
    success: boolean
    operation: 'install' | 'rollback'
    nodeId: string
    ticketId: string
    catalogId: string
    entryHash: string
    catalogHash: string
    catalogSigned: boolean
    approvedBy: string
    alreadyInstalled?: boolean
    steps: InstallStepRecord[]
    verify: InstallStepRecord[]
    before?: { count: number; hash: string }
    after?: { count: number; hash: string }
    newPackages?: string[]
    rollback?: { argv: string[] } | { blocked: string } | null
    rolledBack?: boolean
    restored?: boolean
    error?: string
    startedAt: string
    finishedAt: string
    evidenceHash: string
    signature?: string
}
export interface InstallAdmission { ticketId: string; replayed: boolean; done: Promise<InstallReceipt> }

const SAFE_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
const SAFE_DIR = /^\/(?:[A-Za-z0-9._@+-]+\/?)*$/
const DPKG_QUERY = '/usr/bin/dpkg-query'
const NVIDIA_SMI = '/usr/bin/nvidia-smi'

export function execFileInstallExecutor(): InstallExecutor {
    return {
        run: (file, args, options) => new Promise(resolve => {
            execFile(file, args, {
                shell: false, timeout: options.timeoutMs, env: options.env, uid: options.uid, gid: options.gid,
                maxBuffer: 8 * 1024 * 1024, windowsHide: true, killSignal: 'SIGTERM', encoding: 'utf8',
            }, (error: any, stdout, stderr) => {
                const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0
                resolve({ code, stdout: String(stdout || ''), stderr: String(stderr || '') || (error && typeof error.code !== 'number' ? String(error.message || '') : ''), timedOut: Boolean(error?.killed) })
            })
        }),
    }
}

export function defaultInstallProbe(executor: InstallExecutor): InstallProbe {
    return {
        freeBytes(path) {
            try { const stat = statfsSync(path); return Number(stat.bavail) * Number(stat.bsize) } catch { return null }
        },
        async gpuUtilization() {
            if (!existsSync(NVIDIA_SMI)) return undefined
            const result = await executor.run(NVIDIA_SMI, ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], { timeoutMs: 15_000, env: { PATH: SAFE_PATH, LANG: 'C' } })
            if (result.code !== 0) return null
            const values = result.stdout.split(/\r?\n/).map(line => Number(line.trim())).filter(value => Number.isFinite(value))
            return values.length ? Math.max(...values) : null
        },
    }
}

/** Durable state write; the intent record is the ticket's single-use claim (shared core signed-ticket.ts). */
function writeDurable(path: string, value: unknown, exclusive = false): void {
    if (exclusive) claimTicketOnce(path, value)
    else writeDurableJson(path, value)
}

const stripArch = (name: string) => name.replace(/:[a-z0-9]+$/, '')
const listHash = (values: string[]) => createHash('sha256').update(values.join('\n')).digest('hex')
const tail = (value: string) => redactSecrets(String(value || '')).slice(-2000)

export function parseDpkgList(output: string): string[] {
    return [...new Set(output.split(/\r?\n/)
        .map(line => /^ii\S*\s*\|(\S+)$/.exec(line.trim()))
        .filter((match): match is RegExpExecArray => !!match)
        .map(match => match[1]))].sort()
}

export function createHostInstaller(options: HostInstallerOptions, executor: InstallExecutor = execFileInstallExecutor(), probe: InstallProbe = defaultInstallProbe(executor)) {
    const opt = { ...options }
    const catalog = opt.catalog || getInstallCatalog()
    const now = opt.now || Date.now
    if (!opt.nodeId || !opt.clientId || !opt.ticketPublicKey) throw Error('Installer braucht Knoten, Client und Ticket-Schlüssel')
    for (const [name, value] of Object.entries(opt.paths || {})) {
        if (typeof value !== 'string' || !SAFE_DIR.test(value) || value.includes('..')) throw Error(`Unsicherer Pfad für ${name}`)
    }
    if (opt.serviceUser && (!Number.isInteger(opt.serviceUser.uid) || !Number.isInteger(opt.serviceUser.gid) || opt.serviceUser.uid === 0
        || !SAFE_DIR.test(opt.serviceUser.home) || opt.serviceUser.home.includes('..'))) throw Error('Dienstbenutzer ungültig (nicht root, sicherer Home-Pfad)')
    const root = join(opt.stateDir, 'install')
    mkdirSync(root, { recursive: true, mode: 0o700 })
    let busy = false

    const statePath = (id: string) => {
        if (!TICKET_ID_PATTERN.test(id)) throw Error('Ungültige Ticket-ID')
        return join(root, `${id}.json`)
    }
    const readState = (id: string): any => {
        const path = statePath(id)
        return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
    }

    function placeholderValue(name: PlaceholderName): string | undefined {
        if (name === 'nodeLlamaCppVersion') {
            const runtime = opt.paths?.runtime
            if (!runtime) return undefined
            try {
                const version = JSON.parse(readFileSync(join(runtime, 'node_modules', 'node-llama-cpp', 'package.json'), 'utf8')).version
                return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? version : undefined
            } catch { return undefined }
        }
        return opt.paths?.[name]
    }

    /** Placeholders come from operator config only, never from the ticket. */
    function resolveArgv(argv: readonly string[]): string[] {
        return argv.map(arg => {
            let value = arg
            for (const name of PLACEHOLDERS) {
                if (!value.includes(`{${name}}`)) continue
                const replacement = placeholderValue(name)
                if (!replacement) throw Error(`Platzhalter {${name}} ist auf diesem Host nicht eingerichtet`)
                value = value.split(`{${name}}`).join(replacement)
            }
            if (!isSafeArgument(value) || /[{}]/.test(value)) throw Error('Aufgelöstes Argument unzulässig')
            return value
        })
    }

    function envFor(entry: InstallCatalogEntry): Pick<InstallExecOptions, 'env' | 'uid' | 'gid'> {
        if (entry.runAs === 'service') {
            if (!opt.serviceUser) throw Error('Dienstbenutzer nicht eingerichtet')
            return { env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', HOME: opt.serviceUser.home }, uid: opt.serviceUser.uid, gid: opt.serviceUser.gid }
        }
        return { env: { PATH: SAFE_PATH, LANG: 'C.UTF-8', HOME: '/root', DEBIAN_FRONTEND: 'noninteractive' } }
    }

    async function runChecked(argv: string[], exec: Pick<InstallExecOptions, 'env' | 'uid' | 'gid'>, timeoutMs: number): Promise<InstallStepRecord> {
        const never = neverListViolation(argv)
        if (never) throw Error(`Nie-Liste: ${never.ruleId} (${never.value})`)
        const started = Date.now()
        const result = await executor.run(argv[0], argv.slice(1), { ...exec, timeoutMs })
        return { argv, code: result.timedOut ? -2 : result.code, ms: Date.now() - started, output: tail(`${result.stdout}\n${result.stderr}`) }
    }

    async function dpkgList(): Promise<string[]> {
        const record = await executor.run(DPKG_QUERY, ['-W', '-f=${db:Status-Abbrev}|${binary:Package}\\n'], { timeoutMs: 60_000, env: { PATH: SAFE_PATH, LANG: 'C' } })
        if (record.code !== 0) throw Error('Paketliste nicht lesbar')
        return parseDpkgList(record.stdout)
    }

    function requirementRefusal(entry: InstallCatalogEntry): string | null {
        if (!entry.targets.includes('host-agent')) return 'Eintrag ist nicht für den Host-Agenten bestimmt'
        const r = entry.requires || {}
        if (r.platform && (opt.platform || process.platform) !== r.platform) return `Nur für ${r.platform}`
        if (r.arch && (opt.arch || process.arch) !== r.arch) return `Nur für ${r.arch}`
        if (r.gpuVendor && (opt.gpuVendor || (existsSync(NVIDIA_SMI) ? 'nvidia' : 'none')) !== r.gpuVendor) return `Nur mit ${r.gpuVendor}-GPU`
        return null
    }

    function finish(base: Omit<InstallReceipt, 'evidenceHash' | 'signature' | 'finishedAt'>): InstallReceipt {
        const receipt: InstallReceipt = { ...base, finishedAt: new Date(now()).toISOString(), evidenceHash: '' }
        const { evidenceHash: _e, signature: _s, ...rest } = receipt
        receipt.evidenceHash = createHash('sha256').update(canonicalJson(rest)).digest('hex')
        if (opt.receiptPrivateKey) receipt.signature = sign(null, Buffer.from(`xaventra-install-receipt:${receipt.evidenceHash}`), opt.receiptPrivateKey).toString('base64')
        return receipt
    }

    function baseReceipt(ticket: InstallTicket): Omit<InstallReceipt, 'evidenceHash' | 'signature' | 'finishedAt' | 'success'> {
        return {
            operation: ticket.operation, nodeId: opt.nodeId, ticketId: ticket.id, catalogId: ticket.catalogId, entryHash: ticket.entryHash,
            catalogHash: catalog.hash, catalogSigned: opt.catalogSigned === true, approvedBy: ticket.approvedBy, steps: [], verify: [],
            startedAt: new Date(now()).toISOString(),
        }
    }

    async function runVerify(entry: InstallCatalogEntry, exec: Pick<InstallExecOptions, 'env' | 'uid' | 'gid'>): Promise<{ ok: boolean; records: InstallStepRecord[] }> {
        const records: InstallStepRecord[] = []
        for (const argv of entry.verify) records.push(await runChecked(resolveArgv(argv), exec, 60_000))
        return { ok: records.every(record => record.code === 0), records }
    }

    async function performInstall(ticket: InstallTicket, entry: InstallCatalogEntry, path: string, binding: string): Promise<InstallReceipt> {
        const receipt = { ...baseReceipt(ticket) } as any
        const exec = envFor(entry)
        let before: string[] | null = null
        let mutated = false
        const rollbackFor = (after: string[] | null): InstallReceipt['rollback'] => {
            if (entry.rollback.kind === 'command') {
                const argv = resolveArgv(entry.rollback.argv)
                const never = neverListViolation(argv)
                return never ? { blocked: `Nie-Liste: ${never.ruleId}` } : { argv }
            }
            if (!before || !after) return { blocked: 'Paketliste fehlt' }
            const added = after.filter(name => !before!.includes(name))
            receipt.newPackages = added
            if (!added.length) return null
            const never = packageNeverListViolation(added.map(stripArch))
            if (never) return { blocked: `Nie-Liste: ${never.ruleId} (${never.value})` }
            // Only the packages this installation added; never autoremove.
            return { argv: [APT_GET, 'remove', '-y', '--', ...added] }
        }
        try {
            const verifyBefore = await runVerify(entry, exec)
            if (verifyBefore.ok) {
                receipt.verify = verifyBefore.records; receipt.alreadyInstalled = true; receipt.rollback = null
                const result = finish({ ...receipt, success: true })
                writeDurable(path, { binding, phase: 'completed', ticket, receipt: result })
                return result
            }
            if (entry.kind === 'apt') {
                before = await dpkgList()
                receipt.before = { count: before.length, hash: listHash(before) }
                // Simulation first: an install that would remove anything is refused.
                const simulation = await executor.run(APT_GET, ['install', '-s', '--no-install-recommends', ...(entry.packages || [])], { timeoutMs: 120_000, ...exec })
                if (simulation.code !== 0) throw Error('apt-Simulation fehlgeschlagen')
                if (/^Remv /m.test(simulation.stdout)) throw Error('apt würde Pakete entfernen: abgelehnt')
            }
            writeDurable(path, { binding, phase: 'running', ticket, before })
            for (const argv of entry.prepare || []) {
                const record = await runChecked(resolveArgv(argv), exec, 300_000)
                receipt.steps.push(record)
                if (record.code !== 0) throw Error('Vorbereitung fehlgeschlagen')
            }
            mutated = true
            const install = await runChecked(resolveArgv(entry.install), exec, entry.timeoutSec * 1000)
            receipt.steps.push(install)
            const verifyAfter = await runVerify(entry, exec)
            receipt.verify = verifyAfter.records
            const after = entry.kind === 'apt' ? await dpkgList() : null
            if (after) receipt.after = { count: after.length, hash: listHash(after) }
            receipt.rollback = rollbackFor(after)
            if (install.code !== 0 || !verifyAfter.ok) throw Error(install.code !== 0 ? 'Installation fehlgeschlagen' : 'Nachher-Probe fehlgeschlagen')
            const result = finish({ ...receipt, success: true })
            writeDurable(path, { binding, phase: 'completed', ticket, before, receipt: result })
            return result
        } catch (error) {
            receipt.error = redactSecrets(String((error as Error).message || error)).slice(0, 250)
            if (mutated) {
                try {
                    if (receipt.rollback === undefined) receipt.rollback = rollbackFor(entry.kind === 'apt' ? await dpkgList() : null)
                    const plan = receipt.rollback
                    if (plan && 'argv' in plan) {
                        const record = await runChecked(plan.argv, exec, entry.timeoutSec * 1000)
                        receipt.steps.push(record)
                        receipt.rolledBack = record.code === 0
                    } else receipt.rolledBack = plan === null
                    if (entry.kind === 'apt' && before) {
                        const current = await dpkgList()
                        receipt.restored = listHash(current) === listHash(before)
                    }
                } catch (rollbackError) {
                    receipt.rolledBack = false
                    receipt.error += `; Rückweg: ${redactSecrets(String((rollbackError as Error).message)).slice(0, 120)}`
                }
            }
            const result = finish({ ...receipt, success: false })
            writeDurable(path, { binding, phase: 'completed', ticket, before, receipt: result })
            return result
        }
    }

    async function performRollback(ticket: InstallTicket, entry: InstallCatalogEntry, prior: any, path: string, binding: string): Promise<InstallReceipt> {
        const receipt = { ...baseReceipt(ticket) } as any
        const exec = envFor(entry)
        try {
            const plan = prior.receipt.rollback
            writeDurable(path, { binding, phase: 'running', ticket })
            if (plan && 'argv' in plan) {
                const never = neverListViolation(plan.argv)
                if (never) throw Error(`Nie-Liste: ${never.ruleId}`)
                const record = await runChecked(plan.argv, exec, entry.timeoutSec * 1000)
                receipt.steps.push(record)
                if (record.code !== 0) throw Error('Rückweg fehlgeschlagen')
            }
            receipt.rolledBack = true
            if (entry.kind === 'apt' && Array.isArray(prior.before)) {
                const current = await dpkgList()
                receipt.after = { count: current.length, hash: listHash(current) }
                receipt.restored = listHash(current) === listHash(prior.before)
            }
            const result = finish({ ...receipt, success: receipt.restored !== false })
            writeDurable(path, { binding, phase: 'completed', ticket, receipt: result })
            writeDurable(statePath(prior.ticket.id), { ...prior, rolledBackBy: ticket.id })
            return result
        } catch (error) {
            receipt.error = redactSecrets(String((error as Error).message || error)).slice(0, 250)
            const result = finish({ ...receipt, success: false, rolledBack: false })
            writeDurable(path, { binding, phase: 'completed', ticket, receipt: result })
            return result
        }
    }

    return {
        catalog,
        /** Validates synchronously-before-work; the returned promise carries the receipt. */
        async admit(signed: unknown): Promise<InstallAdmission> {
            const ticket = verifyInstallTicket(signed, { nodeId: opt.nodeId, clientId: opt.clientId, publicKey: opt.ticketPublicKey, catalog, now: now() })
            const entry = catalog.entries.find(item => item.id === ticket.catalogId)!
            const path = statePath(ticket.id)
            const binding = createHash('sha256').update(installTicketBytes(ticket)).digest('hex')
            if (existsSync(path)) {
                const prior = JSON.parse(readFileSync(path, 'utf8'))
                if (prior.binding !== binding) throw Error('Ticket-ID für eine andere Operation wiederverwendet')
                if (prior.phase !== 'completed') throw Error('Vorheriger Ausgang unklar; Betreiber muss abgleichen')
                return { ticketId: ticket.id, replayed: true, done: Promise.resolve(prior.receipt) }
            }
            const requirement = requirementRefusal(entry)
            if (requirement) throw Error(requirement)
            let prior: any = null
            if (ticket.operation === 'rollback') {
                prior = readState(ticket.installTicketId!)
                if (!prior || prior.phase !== 'completed' || !prior.receipt?.success || prior.ticket?.catalogId !== ticket.catalogId) throw Error('Keine abgeschlossene Installation für diesen Rückweg')
                if (prior.rolledBackBy) throw Error('Rückweg wurde bereits ausgeführt')
                if (prior.receipt.rollback && 'blocked' in prior.receipt.rollback) throw Error(`Rückweg gesperrt: ${prior.receipt.rollback.blocked}`)
            } else {
                // Resolve every argv before any work, so a missing placeholder never leaves a half-run.
                for (const argv of [...(entry.prepare || []), entry.install, ...entry.verify]) resolveArgv(argv)
                if (entry.rollback.kind === 'command') resolveArgv(entry.rollback.argv)
                envFor(entry)
                const gpu = await probe.gpuUtilization()
                const refusal = resourceRefusal(entry, { freeBytes: probe.freeBytes(opt.diskPath || '/'), gpuUtilization: gpu, modelOnly: opt.modelOnly })
                if (refusal) throw Error(refusal)
            }
            if (busy) throw Error('Eine andere Installation läuft bereits')
            busy = true
            try { writeDurable(path, { binding, phase: 'intent', ticket }, true) } catch (error) { busy = false; throw error }
            const done = (ticket.operation === 'rollback' ? performRollback(ticket, entry, prior, path, binding) : performInstall(ticket, entry, path, binding))
                .finally(() => { busy = false })
            return { ticketId: ticket.id, replayed: false, done }
        },
        status(ticketId: unknown): { phase: string; receipt?: InstallReceipt } | null {
            if (typeof ticketId !== 'string' || !TICKET_ID_PATTERN.test(ticketId)) throw Error('Ungültige Ticket-ID')
            const state = readState(ticketId)
            return state ? { phase: state.phase, receipt: state.receipt } : null
        },
    }
}
export type HostInstaller = ReturnType<typeof createHostInstaller>
