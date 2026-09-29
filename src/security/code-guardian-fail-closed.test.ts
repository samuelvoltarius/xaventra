import { afterEach, describe, expect, it } from 'vitest'
import { fullSecurityCheck, sandboxTest } from './code-guardian.js'

// CodeGuardian regression (review "Mittel/Sicherheit"): runtime errors and
// sandbox failures used to count as safe, and the sandbox exposed host-realm
// functions, so evaluated code could reach the real process.

afterEach(() => { delete (globalThis as any).__codeGuardianEscape })

describe('CodeGuardian sandbox is fail-closed', () => {
    it('treats runtime errors as unsafe', async () => {
        expect((await sandboxTest('throw new Error("boom")')).safe).toBe(false)
        expect((await sandboxTest('undefinedFunction()')).safe).toBe(false)
    })

    it('treats code it cannot evaluate (syntax error) as unsafe', async () => {
        expect((await sandboxTest('const = ;')).safe).toBe(false)
    })

    it('still accepts plain safe code', async () => {
        expect((await sandboxTest('const a = [1,2,3].map(x => x * 2); module.exports = a')).safe).toBe(true)
    })

    it.each([
        'console.log.constructor("globalThis.__codeGuardianEscape = true")()',
        'this.constructor.constructor("globalThis.__codeGuardianEscape = true")()',
        'Math.max.constructor("globalThis.__codeGuardianEscape = true")()',
        'JSON.parse.constructor("globalThis.__codeGuardianEscape = true")()',
        'setTimeout.constructor("globalThis.__codeGuardianEscape = true")()',
        'require.constructor("globalThis.__codeGuardianEscape = true")()',
        'Object.getPrototypeOf(process).constructor.constructor("globalThis.__codeGuardianEscape = true")()',
    ])('does not let evaluated code reach the host realm: %s', async code => {
        await sandboxTest(code)
        expect((globalThis as any).__codeGuardianEscape).toBeUndefined()
    })

    it('fullSecurityCheck rejects code whose sandbox run fails', async () => {
        const result = await fullSecurityCheck('throw new Error("boom")', 'guardian-fixture.js', 'nova-self')
        expect(result.allowed).toBe(false)
    })

    it('fullSecurityCheck does not execute code the AST analysis already rejected', async () => {
        const result = await fullSecurityCheck('eval("1+1")', 'guardian-fixture.js', 'nova-self')
        expect(result.allowed).toBe(false)
        expect(result.sandboxResult).toBeNull()
    })

    it('fullSecurityCheck still allows plain safe code', async () => {
        const result = await fullSecurityCheck('const total = [1, 2].reduce((a, b) => a + b, 0)\nmodule.exports = total\n', 'guardian-fixture.js', 'nova-self')
        expect(result.allowed).toBe(true)
    })
})
