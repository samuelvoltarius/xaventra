import { describe, expect, it, beforeEach, vi } from 'vitest'
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { createServer, type RequestListener } from 'node:http'
import { downloadModel, checkedDownloadUrl, runDoctorDownloadCli } from './download-models.js'
import { MODEL_REGISTRY, getDoctorMirror, getConfiguredArtifact, selectInstalledModel } from './doctor-artifacts.js'

const bytes = Buffer.from('GGUF-small-test-artifact-not-an-inference-model')
const model = { filename: 'fixture.gguf', sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), sizeMB: 1, quality: 1, minRamGB: 0 }
const dest = () => join(process.cwd(), 'models', model.filename)
beforeEach(() => {
    vi.unstubAllEnvs()
    writeFileSync(join(process.cwd(), 'xaventra.config.json'), '{}')
    rmSync(join(process.cwd(), 'models'), { recursive: true, force: true })
    mkdirSync(join(process.cwd(), 'models'), { recursive: true })
})
async function server(handler: RequestListener, test: (mirror: string) => Promise<void>) {
    const s = createServer(handler)
    await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
    try { await test(`http://127.0.0.1:${(s.address() as any).port}`) }
    finally { s.closeAllConnections(); await new Promise<void>(r => s.close(() => r())) }
}

describe('Doctor artifact release contract', () => {
    it('honors doctorModel=off in selection', async () => {
        const { hasLocalModel } = await import('./llama-engine.js')
        mkdirSync(join(process.cwd(), 'models'), { recursive: true })
        writeFileSync(join(process.cwd(), 'models', 'nova-doctor-0.5b-q2k.gguf'), 'GGUF-incomplete')
        writeFileSync(join(process.cwd(), 'xaventra.config.json'), JSON.stringify({ doctorModel: 'off' }))
        expect(hasLocalModel()).toBe(false)
    })
    it('pins match the independently checked-in checksum list', () => {
        const sums = readFileSync(join(process.env.NOVA_PROJECT_ROOT!, 'models/SHA256SUMS'), 'utf8')
        for (const m of MODEL_REGISTRY) expect(sums).toContain(`${m.sha256} *${m.filename}`)
    })
    it('reads mirror config and never falls back from an explicit missing model', () => {
        writeFileSync('xaventra.config.json', JSON.stringify({ doctorModelMirror: 'https://mirror.example/models', doctorModel: '1.5b-q5km' }))
        expect(getDoctorMirror()).toBe('https://mirror.example/models')
        expect(selectInstalledModel()).toBeNull()
    })
    it('requires custom pins and rejects traversal', () => {
        writeFileSync('xaventra.config.json', JSON.stringify({ doctorModel: '../bad.gguf' }))
        expect(() => getConfiguredArtifact()).toThrow()
        writeFileSync('xaventra.config.json', JSON.stringify({ doctorModel: 'custom.gguf' }))
        expect(() => getConfiguredArtifact()).toThrow()
    })
    it.each(['http://example.com/models', 'https://user:secret@example.com', 'file:///models'])('rejects unsafe mirror %s', (url) => {
        expect(() => checkedDownloadUrl(url)).toThrow()
    })
    it('rejects HTTPS downgrade even to loopback', () => {
        expect(() => checkedDownloadUrl('http://127.0.0.1/model', new URL('https://example.com'))).toThrow()
    })
    it('downloads and verifies exact bytes, then skips offline without any mirror', async () => {
        await server((_req, res) => res.end(bytes), async mirror => {
            await downloadModel(model, undefined, { mirror })
            expect(readFileSync(dest())).toEqual(bytes)
            await downloadModel(model, undefined, { mirror: 'not-a-url' })
        })
    })
    it('restarts instead of appending when the mirror ignores Range', async () => {
        writeFileSync(dest() + '.download', bytes.subarray(0, 8))
        await server((req, res) => { expect(req.headers.range).toBe('bytes=8-'); res.end(bytes) }, async mirror => {
            await downloadModel(model, undefined, { mirror })
            expect(readFileSync(dest())).toEqual(bytes)
        })
    })
    it('resumes a verified 206 range and relative 308 redirect', async () => {
        writeFileSync(dest() + '.download', bytes.subarray(0, 8))
        await server((req, res) => {
            if (!req.url!.startsWith('/actual')) { res.writeHead(308, { location: '/actual' }); res.end(); return }
            expect(req.headers.range).toBe('bytes=8-')
            res.writeHead(206, { 'content-range': `bytes 8-${bytes.length - 1}/${bytes.length}` }); res.end(bytes.subarray(8))
        }, async mirror => { await downloadModel(model, undefined, { mirror }); expect(readFileSync(dest())).toEqual(bytes) })
    })
    it.each(['checksum', 'range', 'oversize', 'truncated', '404'])('fails closed on %s and preserves the old artifact', async failure => {
        writeFileSync(dest(), 'previous-artifact')
        await server((_req, res) => {
            if (failure === 'range') { res.writeHead(206, { 'content-range': 'bytes 9-10/100' }); res.end(bytes); return }
            if (failure === '404') { res.writeHead(404); res.end(); return }
            if (failure === 'checksum') { res.end(Buffer.alloc(bytes.length)); return }
            if (failure === 'oversize') { res.writeHead(200, { 'transfer-encoding': 'chunked' }); res.end(Buffer.concat([bytes, bytes])); return }
            res.end(bytes.subarray(0, 8))
        }, async mirror => {
            await expect(downloadModel(model, undefined, { mirror })).rejects.toThrow()
            expect(readFileSync(dest(), 'utf8')).toBe('previous-artifact')
            expect(existsSync(dest() + '.lock')).toBe(false)
        })
    })
    it('bounds stalled downloads and removes its lock', async () => {
        await server(() => {}, async mirror => {
            await expect(downloadModel(model, undefined, { mirror, timeoutMs: 40 })).rejects.toThrow()
            expect(existsSync(dest())).toBe(false)
            expect(existsSync(dest() + '.lock')).toBe(false)
        })
    })
    it('does not disclose GitHub credentials to a mirror with github.com in its path', async () => {
        vi.stubEnv('GITHUB_TOKEN', 'synthetic-fixture-token')
        await server((req, res) => { expect(req.headers.authorization).toBeUndefined(); res.end(bytes) }, async mirror => {
            await downloadModel(model, undefined, { mirror: mirror + '/github.com' })
        })
    })
    it('refuses simultaneous downloads and explicit disabled installs', async () => {
        writeFileSync(dest() + '.lock', '')
        await expect(downloadModel(model)).rejects.toThrow('locked')
        writeFileSync('xaventra.config.json', '{"doctorModel":"off"}')
        await expect(downloadModel(model)).rejects.toThrow('disabled')
    })
    it('rejects malformed/ambiguous CLI flags and reports default failure', async () => {
        await expect(runDoctorDownloadCli(['--model'])).rejects.toThrow('Usage')
        await expect(runDoctorDownloadCli(['--model', '0.5b'])).rejects.toThrow('ambiguous')
        writeFileSync('xaventra.config.json', '{"doctorModel":"off"}')
        expect(await runDoctorDownloadCli([])).toBe(1)
    })
    it('does not select an artifact exceeding the hardware budget', async () => {
        vi.resetModules()
        vi.doMock('node:os', () => ({ totalmem: () => 512 * 1024 ** 2 }))
        try {
            const { selectBestModel } = await import('./download-models.js')
            expect(selectBestModel()).toBeNull()
        } finally { vi.doUnmock('node:os'); vi.resetModules() }
    })
})
