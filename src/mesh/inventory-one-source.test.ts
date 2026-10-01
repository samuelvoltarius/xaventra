/**
 * 2.82.0 Aufräumen Punkt 6: Inventar — je Sache eine Quelle.
 * Modell-Listen (eine Abfrage je Anbieter), KI-Ports (ein Probe-Client mit
 * Cache), SSH (ein Ausführer mit geteilter Erreichbarkeit), GPU (gpu-runtime,
 * asynchron mit Cache), Programme (EnvScanner), Probe-Cache-Schema.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchModelList, resetModelListCache } from '../llm/model-list-cache.js'
import { resetNodeSsh, sshNodeRun, sshReachability, SSH_UNREACHABLE_HOLD_MS } from './node-ssh.js'
import { cachedNvidiaQuery, nvidiaStaticInfo, queryNvidia, resetNvidiaSmi } from '../doctor/nvidia-smi.js'
import { locateProgram } from '../startup/environment-scanner.js'
import { readProbeResults } from '../llm/capability-probe.js'

const src = (path: string) => readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8')
afterEach(() => { resetModelListCache(); resetNodeSsh() })

describe('Modell-Listen: eine Abfrage je Anbieter', () => {
    it('vier Aufrufer, gleiche URL und gleicher Schlüssel → eine Anfrage; andere Zugangsdaten → eigene', async () => {
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), { status: 200 }))
        resetModelListCache(fetchImpl as any)
        const url = 'https://api.example.com/v1/models'
        const callers = await Promise.all([
            fetchModelList(url, { headers: { Authorization: 'Bearer test-a' } }),
            fetchModelList(url, { headers: { Authorization: 'Bearer test-a', 'Content-Type': 'application/json' } }),
        ])
        const later = await fetchModelList(url, { headers: { Authorization: 'Bearer test-a' } })
        const other = await fetchModelList(url, { headers: { Authorization: 'Bearer test-b' } })
        expect(fetchImpl).toHaveBeenCalledTimes(2)
        expect((await callers[0].json()).data[0].id).toBe('gpt-x')
        expect(later.cached).toBe(true)
        expect(other.cached).toBe(false)
    })

    it('ein Netzfehler wirft wie fetch (Aufrufer fallen zurück) und wird nur kurz geteilt', async () => {
        const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
        resetModelListCache(fetchImpl as any)
        await expect(fetchModelList('https://api.example.com/v1/models')).rejects.toThrow(/ECONNREFUSED/)
        await expect(fetchModelList('https://api.example.com/v1/models')).rejects.toThrow()
        expect(fetchImpl).toHaveBeenCalledTimes(1)
    })

    it('llm-factory, model-resolver, model-discovery und ProviderRegistry fragen /models nur noch darüber ab', () => {
        for (const file of ['core/llm-factory.ts', 'core/model-resolver.ts', 'llm/model-discovery.ts', 'llm/provider-registry.ts']) {
            const text = src(file)
            expect(text, file).toMatch(/fetchModelList\(/)
            expect(text, file).not.toMatch(/await fetch\([^)]*\/models/)
        }
    })
})

describe('KI-Ports: ein Probe-Client für alle', () => {
    it('model-resolver, Self-Setup und LocalLLM fragen über probeAiJson (geteilte Antwort, Backoff, Latenz)', () => {
        expect(src('core/model-resolver.ts')).toMatch(/probeAiJson\(svc\.endpoint, '\/api\/tags'/)
        expect(src('core/self-setup-orchestrator.ts')).toMatch(/probeAiJson\(endpoint, '\/api\/tags'/)
        expect(src('llm/local-llm.ts')).toMatch(/probeAiJson\(this\.config\.baseUrl/)
        expect(src('mesh/ai-scanner.ts')).toMatch(/getAiProbeClient\(\)/)
    })
})

describe('SSH: ein Ausführer, geteilte Erreichbarkeit', () => {
    it('ein toter Knoten: L21 misst, AIScan/NodeIntelligence überspringen 5 min statt eigener Zeitlimits', async () => {
        let t = 1_000_000
        const calls: string[][] = []
        let exitCode: number | null = 255
        resetNodeSsh({ now: () => t, exec: async args => { calls.push(args); return exitCode === 0 ? { stdout: 'ok\n', exitCode: 0 } : { stdout: '', exitCode, error: 'ssh: connect to host 192.0.2.21 port 22: Connection timed out' } } })
        const l21 = await sshNodeRun('pi@192.0.2.21', 'uptime', { measure: true })
        expect(l21).toMatchObject({ ok: false, unreachable: true, skipped: false })
        expect(sshReachability('192.0.2.21')).toMatchObject({ ok: false })
        const aiscan = await sshNodeRun('pi@192.0.2.21', 'dpkg --get-selections')
        const nodeIntel = await sshNodeRun('pi@192.0.2.21', 'uname -s')
        expect([aiscan.skipped, nodeIntel.skipped]).toEqual([true, true])
        expect(calls).toHaveLength(1)
        expect(calls[0]).toEqual(['-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=5', '-o', 'BatchMode=yes', '--', 'pi@192.0.2.21', 'uptime'])
        // L21 keeps measuring; once it is back, the others ask again.
        exitCode = 0
        expect((await sshNodeRun('pi@192.0.2.21', 'uptime', { measure: true })).ok).toBe(true)
        expect((await sshNodeRun('pi@192.0.2.21', 'uname -s')).ok).toBe(true)
        t += SSH_UNREACHABLE_HOLD_MS
    })

    it('ein fehlschlagender Befehl ist kein Erreichbarkeitsproblem; gleiche Antwort wird geteilt; Optionen werden abgelehnt', async () => {
        const calls: string[][] = []
        resetNodeSsh({ exec: async args => { calls.push(args); return args.at(-1) === 'uname -o' ? { stdout: '', exitCode: 1, error: 'unknown option' } : { stdout: 'Linux\n', exitCode: 0 } } })
        expect((await sshNodeRun('ops@ns1.example.com', 'uname -o')).unreachable).toBe(false)
        expect(sshReachability('ns1.example.com')?.ok).toBe(true)
        await sshNodeRun('ops@ns1.example.com', 'uname -s', { cacheMs: 60_000 })
        expect((await sshNodeRun('ops@ns1.example.com', 'uname -s', { cacheMs: 60_000 })).cached).toBe(true)
        expect(calls).toHaveLength(2)
        expect((await sshNodeRun('-oProxyCommand=x', 'id')).skipped).toBe(true)
        expect(calls).toHaveLength(2)
    })

    it('L21, AIScan, NodeIntelligence und model-discovery rufen ssh nicht mehr selbst auf', () => {
        for (const file of ['layers/L21-node-health.ts', 'mesh/ai-scanner.ts', 'mesh/node-intelligence.ts', 'llm/model-discovery.ts']) {
            expect(src(file), file).toMatch(/sshNodeRun\(/)
            expect(src(file), file).not.toMatch(/execFile(?:Async)?\('ssh'|ssh -o StrictHostKeyChecking/)
        }
    })
})

describe('GPU: eine Quelle (gpu-runtime), asynchron mit Cache', () => {
    it('feste Angaben einmal je Prozess; Live-Werte geteilt; der Heartbeat wartet nie', async () => {
        const syncCalls: string[][] = []
        const asyncCalls: string[][] = []
        let release: (value: { ok: boolean; stdout: string }) => void = () => undefined
        resetNvidiaSmi({
            runSync: args => { syncCalls.push(args); return args.length ? { status: 0, stdout: 'NVIDIA GB10, 122880\n' } : { status: 0, stdout: '| CUDA Version: 13.0 |' } },
            runAsync: args => { asyncCalls.push(args); return new Promise(resolve => { release = resolve }) },
        })
        expect(nvidiaStaticInfo()).toEqual({ name: 'NVIDIA GB10', memoryTotalMb: 122880, cudaVersion: '13.0' })
        expect(nvidiaStaticInfo()?.name).toBe('NVIDIA GB10')
        expect(syncCalls).toHaveLength(2)
        // Heartbeat path: no value yet → returns at once, refresh runs in the background.
        expect(cachedNvidiaQuery(['memory.free'])).toBeNull()
        const waiting = queryNvidia(['memory.free'])
        expect(asyncCalls).toHaveLength(1)
        release({ ok: true, stdout: '4096\n' })
        expect(await waiting).toEqual([['4096']])
        expect(cachedNvidiaQuery(['memory.free'])).toEqual([['4096']])
        expect(asyncCalls).toHaveLength(1)
        expect(asyncCalls[0]).toEqual(['--query-gpu=memory.free', '--format=csv,noheader,nounits'])
        expect(await queryNvidia(['memory.free; reboot'])).toBeNull()
    })

    it('ohne NVIDIA-GPU wird nie wieder gestartet', async () => {
        const asyncCalls: string[][] = []
        resetNvidiaSmi({ runSync: () => ({ status: 1, stdout: '' }), runAsync: async args => { asyncCalls.push(args); return { ok: false, stdout: '' } } })
        expect(nvidiaStaticInfo()).toBeNull()
        expect(await queryNvidia(['power.draw'])).toBeNull()
        expect(asyncCalls).toHaveLength(0)
    })

    it('kein Modul ruft nvidia-smi lokal mehr selbst auf (Heartbeat nicht mehr synchron)', () => {
        for (const file of ['mesh/mesh-registry.ts', 'core/hardware-role.ts', 'layers/vram-manager.ts', 'core/model-pricing.ts', 'thinking/ports.ts', 'llm/llama-engine.ts', 'doctor/gpu-runtime.ts']) {
            expect(src(file), file).not.toMatch(/(?:execSync|spawnSync|execFile|commandWorks|commandOutput)\(\s*['`]nvidia-smi/)
        }
        expect(src('mesh/mesh-registry.ts')).toMatch(/cachedNvidiaQuery\(\['memory\.free'\]\)/)
    })
})

describe('Programme: eine Suche (EnvScanner)', () => {
    it('nur reine Programmnamen, Ergebnis geteilt', () => {
        expect(locateProgram('node')).toBeTruthy()
        expect(locateProgram('node; rm -rf /')).toBeUndefined()
        expect(locateProgram('-v')).toBeUndefined()
        expect(locateProgram('definitely-not-installed-xaventra-tool')).toBeUndefined()
        expect(src('core/environment.ts')).toMatch(/return Boolean\(locateProgram\(cmd\)\)/)
        expect(src('mesh/mesh-registry.ts')).not.toMatch(/which \$\{bin\}|execSync\('(?:ffmpeg -version|git --version|adb version|ssh -V)/)
        expect(src('mesh/ai-scanner.ts')).not.toMatch(/`which \$\{binary\}|`where \$\{binary\}/)
    })
})

describe('Probe-Cache-Schema (models vs. results)', () => {
    it('llm-factory liest die Probe-Ergebnisse über das Probe-Modul (Datei hat `results`)', () => {
        const dir = mkdtempSync(join(tmpdir(), 'probe-schema-'))
        const previous = process.cwd()
        mkdirSync(join(dir, '.nova-data'), { recursive: true })
        writeFileSync(join(dir, '.nova-data', 'model-capabilities.json'), JSON.stringify({ version: 2, lastProbed: '', results: { 'http://198.51.100.5:8000|qwen': { model: 'qwen', endpoint: 'http://198.51.100.5:8000', online: true, supportsTools: true } } }))
        process.chdir(dir)
        try {
            expect(readProbeResults().map(item => item.model)).toEqual(['qwen'])
        } finally { process.chdir(previous) }
        expect(src('core/llm-factory.ts')).not.toMatch(/parsed\.models/)
        expect(src('core/llm-factory.ts')).toMatch(/readProbeResults\(\)/)
        expect(src('mesh/capability-graph.ts')).toMatch(/readProbeResults\(\)/)
    })
})
