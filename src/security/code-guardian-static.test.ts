import { afterEach, describe, expect, it } from 'vitest'
import { fullSecurityCheck, isGuardedCodePath } from './code-guardian.js'

// INT-2 regression: the fail-closed CodeGuardian blocked write_file for most
// real module files (imports, unknown identifiers, TypeScript the regex
// stripper could not handle). The gate is now purely static: TypeScript is
// lowered with the compiler API, nothing is executed, and only dangerous
// capabilities are findings.

afterEach(() => { delete (globalThis as any).__codeGuardianEscape })

const TYPICAL_MODULE = `
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DaemonState } from '../core/slash-commands.js'
import { resolvePrincipalId, type PrincipalContext } from '../users/principal-id.js'

export interface Summary<T extends object = Record<string, unknown>> {
    readonly id: string
    items: Array<T>
    meta?: { createdAt: Date; tags: string[] }
}

export enum Level { Low = 1, High = 2 }

export abstract class Base<T> implements Iterable<T> {
    protected constructor(private readonly values: T[]) {}
    abstract describe(): string
    *[Symbol.iterator](): Iterator<T> { yield* this.values }
}

export class Loader extends Base<string> {
    #cache = new Map<string, string>()
    constructor(private state: DaemonState, values: string[] = []) { super(values) }
    describe(): string { return \`Loader(\${this.#cache.size})\` }
    load(file: string, ctx?: PrincipalContext): string | undefined {
        const principal = ctx ? resolvePrincipalId(this.state.config, ctx.channel, ctx.rawUserId) : 'none'
        const hit = this.#cache.get(file)
        if (hit !== undefined) return hit
        const text = readFileSync(join(process.cwd(), file), 'utf-8') satisfies string
        const match = /^# (.+)$/m.exec(text)
        this.#cache.set(file, match?.[1] ?? principal)
        return this.#cache.get(file)!
    }
}

export async function lazy(): Promise<number> {
    const { default: helper } = await import('./helper.js')
    return (helper as unknown as (n: number) => number)(unknownGlobalFromAnotherModule as number)
}

export default function <T,>(x: T): x is NonNullable<T> { return x != null }
`

describe('CodeGuardian write gate is static and admits real modules (INT-2)', () => {
    it('allows a typical project TypeScript module with imports, generics, classes and unknown identifiers', async () => {
        const result = await fullSecurityCheck(TYPICAL_MODULE, 'src/tools/example-module.ts', 'nova-self')
        expect(result.reason).toBeUndefined()
        expect(result.allowed).toBe(true)
        expect(result.sandboxResult).toBeNull()
    })

    it('allows a plain ESM JavaScript module and a CommonJS module', async () => {
        const esm = `import { EventEmitter } from 'node:events'\nexport const bus = new EventEmitter()\nexport function on(n, f) { bus.on(n, f) }\n`
        const cjs = `'use strict'\nconst path = require('path')\nmodule.exports = { rel: p => path.relative(process.cwd(), p) }\n`
        expect((await fullSecurityCheck(esm, 'src/bus.mjs', 'nova-self')).allowed).toBe(true)
        expect((await fullSecurityCheck(cjs, 'scripts/rel.cjs', 'nova-self')).allowed).toBe(true)
    })

    it('does not execute module code while checking', async () => {
        await fullSecurityCheck('globalThis.__codeGuardianEscape = true\nexport const x = 1\n', 'src/side-effect.ts', 'nova-self')
        expect((globalThis as any).__codeGuardianEscape).toBeUndefined()
    })

    it.each([
        ['import child_process', `import { exec } from 'child_process'\nexport const run = (c: string) => exec(c)\n`],
        ['import node:child_process (unused)', `import { spawn } from 'node:child_process'\nexport const x: number = 1\n`],
        ['re-export child_process', `export * from 'node:child_process'\n`],
        ['dynamic child_process import', `export async function f(): Promise<void> { const cp = await import('node:child_process'); cp.execSync('id') }\n`],
        ['obfuscated require', `export const r = require('chi' + 'ld_process')\n`],
        ['template require', 'export const r = require(`child_${"process"}`)\n'],
        ['variable import()', `export async function load(name: string): Promise<unknown> { return import(name) }\n`],
        ['eval', `export const v = eval('1 + 1')\n`],
        ['indirect eval', `export const v = (0, eval)('1 + 1')\n`],
        ['globalThis.eval', `export const v = (0, globalThis.eval)('1 + 1')\n`],
        ['Function as value', `const F = Function\nexport const g = F('return process')\n`],
        ['new Function', `export const g = new Function('return process')\n`],
        ['process.binding', `export const b = process.binding('spawn_sync')\n`],
        ['constructor chain escape', `export const p = ({}).constructor.constructor('return process')()\n`],
        ['globalThis computed access', `const k: string = 'ev' + 'al'\nexport const v = (globalThis as any)[k]('1')\n`],
        ['vm module', `import vm from 'node:vm'\nexport const r = vm.runInThisContext('1')\n`],
        ['prototype pollution', `export function p(o: any): void { o.__proto__.polluted = true }\n`],
    ])('blocks %s', async (_name, code) => {
        const result = await fullSecurityCheck(code, 'src/evil.ts', 'nova-self')
        expect(result.allowed).toBe(false)
        expect(result.reason).toMatch(/AST/)
    })

    it('rejects TypeScript that the compiler cannot parse (fail-closed)', async () => {
        const result = await fullSecurityCheck('export function (: string {', 'src/broken.ts', 'nova-self')
        expect(result.allowed).toBe(false)
        expect(result.reason).toMatch(/nicht parsebar/)
    })

    it('guards every executable JS/TS extension', () => {
        for (const file of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'a.js', 'a.jsx', 'a.mjs', 'a.cjs', 'A.TS']) expect(isGuardedCodePath(file)).toBe(true)
        for (const file of ['a.md', 'a.json', 'a.d.txt']) expect(isGuardedCodePath(file)).toBe(false)
    })
})
