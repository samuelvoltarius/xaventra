import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInForgeSandbox, sandboxSupport, validateForgeCode, type ForgeManifest, type SandboxFetchRequest } from './forge-sandbox.js'

// Echte Kindprozesse: jede Probe startet `node --permission …` wie im Betrieb.
const lesend: ForgeManifest = { net: ['api.example.org'], fs: [], wirkung: 'lesend' }
const fixtureFetch = async (request: SandboxFetchRequest) => ({ status: 200, headers: { 'content-type': 'text/plain' }, body: `echo ${request.method} ${request.url}` })
const run = (code: string, options: { params?: unknown; manifest?: ForgeManifest; timeoutMs?: number; fetch?: typeof fixtureFetch; readFile?: (path: string) => Promise<string> } = {}) =>
    runInForgeSandbox({
        code, params: options.params ?? {}, manifest: options.manifest ?? lesend, timeoutMs: options.timeoutMs ?? 8_000,
        fetchHandler: options.fetch ?? fixtureFetch,
        readFileHandler: options.readFile ?? (async () => { throw new Error('kein Dateizugriff im Manifest') }),
    })

describe('Werkzeug-Schmiede: Sandbox im Kindprozess', () => {
    it('diese Node-Version hat --permission und module.registerHooks (sonst ehrliche Ablehnung)', () => {
        expect(sandboxSupport()).toEqual({ ok: true })
    })

    it('führt ein reines Werkzeug aus (Gegenprobe) und erlaubt node:crypto', async () => {
        const result = await run(`import { createHash } from 'node:crypto'
export default async function (params) { return { sum: params.a + params.b, hash: createHash('sha256').update('x').digest('hex').slice(0, 8) } }`, { params: { a: 2, b: 3 } })
        expect(result).toMatchObject({ ok: true, value: { sum: 5, hash: '2d711642' } })
    })

    it('Datei schreiben ist abgelehnt (Import, getBuiltinModule, binding)', async () => {
        const target = join(mkdtempSync(join(tmpdir(), 'forge-write-')), 'boese.txt')
        const viaImport = await run(`export default async function () { const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(target)}, 'x'); return 'geschrieben' }`)
        expect(viaImport.ok).toBe(false)
        const viaBuiltin = await run(`export default async function () { process.getBuiltinModule('node:fs').writeFileSync(${JSON.stringify(target)}, 'x'); return 'geschrieben' }`)
        expect(viaBuiltin.ok).toBe(false)
        const viaBinding = await run(`export default async function () { process.binding('fs'); return 'binding' }`)
        expect(viaBinding.ok).toBe(false)
        expect(existsSync(target)).toBe(false)
    })

    it('child_process ist abgelehnt, auch mit Kommentar-Trick im dynamischen Import', async () => {
        const marker = join(mkdtempSync(join(tmpdir(), 'forge-cp-')), 'lief.txt')
        const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`
        for (const code of [
            `export default async function () { const cp = await import(/**/'node:child_process'); cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(script)}]); return 'lief' }`,
            `export default async function () { const cp = process.getBuiltinModule('child_process'); cp.spawnSync(process.execPath, ['-e', ${JSON.stringify(script)}]); return 'lief' }`,
        ]) {
            const result = await run(code)
            expect(result.ok, code).toBe(false)
        }
        expect(existsSync(marker)).toBe(false)
    })

    it('eval und new Function sind im Kind abgeschaltet', async () => {
        expect((await run(`export default async function () { return eval('1+1') }`)).ok).toBe(false)
        expect((await run(`export default async function () { return new Function('return 1')() }`)).ok).toBe(false)
        expect((await run(`export default async function () { return (function(){}).constructor('return 1')() }`)).ok).toBe(false)
    })

    it('Netz nur über ctx.fetch zu Manifest-Hosts; fremder Host und eigenes Netz sind abgelehnt', async () => {
        const allowed = await run(`export default async function (_p, ctx) { const r = await ctx.fetch('https://api.example.org/v1?q=1'); return await r.text() }`)
        expect(allowed).toMatchObject({ ok: true, value: 'echo GET https://api.example.org/v1?q=1' })
        const foreign = await run(`export default async function (_p, ctx) { const r = await ctx.fetch('https://evil.example.com/steal'); return await r.text() }`)
        expect(foreign.ok).toBe(false)
        expect(foreign.error).toMatch(/nicht im Manifest/)
        expect((await run(`export default async function () { return typeof fetch }`)).value).toBe('undefined')
        expect((await run(`export default async function () { const net = await import('node:net'); return 'net' }`)).ok).toBe(false)
        expect((await run(`export default async function () { const h = await import('node:https'); return 'https' }`)).ok).toBe(false)
    })

    it('lesend darf nur GET/HEAD', async () => {
        const post = await run(`export default async function (_p, ctx) { await ctx.fetch('https://api.example.org/x', { method: 'POST', body: 'a' }); return 'gesendet' }`)
        expect(post.ok).toBe(false)
        expect(post.error).toMatch(/lesend/)
    })

    it('sieht keine Umgebungsvariablen und kann keine Prozesse beenden oder die Ausgabe fälschen', async () => {
        process.env.FORGE_TEST_SECRET = 'geheim-123'
        try {
            const env = await run(`export default async function () { return JSON.stringify(process.env) }`)
            expect(String(env.value ?? env.error)).not.toContain('geheim-123')
        } finally { delete process.env.FORGE_TEST_SECRET }
        expect((await run(`export default async function () { process.kill(process.ppid); return 'getötet' }`)).ok).toBe(false)
        const spoof = await run(`export default async function () { process.stdout.write(JSON.stringify({ type: 'result', ok: true, value: 'gefälscht' }) + '\\n'); return 'echt' }`)
        expect(spoof.value).not.toBe('gefälscht')
    })

    it('Zeitlimit beendet eine Endlosschleife', async () => {
        const result = await run(`export default async function () { for (;;) {} }`, { timeoutMs: 1_500 })
        expect(result).toMatchObject({ ok: false, timedOut: true })
    })

    it('ctx.readFile geht nur über den Elternprozess', async () => {
        const result = await run(`export default async function (_p, ctx) { return await ctx.readFile('/erlaubt.txt') }`, { readFile: async path => `inhalt von ${path}` })
        expect(result).toMatchObject({ ok: true, value: 'inhalt von /erlaubt.txt' })
    })
})

describe('Werkzeug-Schmiede: statische Prüfung (CodeGuardian + Modul-Erlaubnisliste)', () => {
    it('lässt ein sauberes Werkzeug mit erlaubtem Import durch', async () => {
        expect(await validateForgeCode(`import { URL } from 'node:url'\nexport default async function (params, ctx) { return new URL(params.u).host }`)).toEqual({ valid: true, errors: [] })
    })

    it.each([
        [`export default async function () { return await import(/**/'node:child_process') }`, /dynamisch/i],
        [`import fs from 'node:fs'\nexport default async function () { return fs }`, /node:fs/],
        [`const cp = require('child_process')\nexport default async function () { return 1 }`, /require/],
        [`export default async function () { return eval('1') }`, /eval/i],
        [`export async function run() { return 1 }`, /export default/],
        [`export default async function ( {`, /parse|Syntax|nicht/i],
    ])('lehnt ab: %s', async (code, reason) => {
        const result = await validateForgeCode(code)
        expect(result.valid).toBe(false)
        expect(result.errors.join(' ')).toMatch(reason)
    })
})
