import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseDependencyAudit, scanSourceForWalletMaterial } from './assurance-gate.js'

const roots: string[] = []

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), 'xaventra-wallet-assurance-'))
    roots.push(root)
    return root
}

describe('wallet material assurance', () => {
    it('blocks nested wallet artifacts as well as repository-root files', () => {
        const root = fixture()
        mkdirSync(join(root, 'assets'))
        writeFileSync(join(root, 'assets', 'wallet.json'), '{}')
        expect(scanSourceForWalletMaterial(root)).toEqual([{ path: 'assets/wallet.json', rule: 'forbidden-wallet-artifact' }])
    })
    it('blocks wallet files without reading their values into the report', () => {
        const root = fixture()
        writeFileSync(join(root, 'wallet.json'), '{"private_key":"should-not-be-reported"}')
        expect(scanSourceForWalletMaterial(root)).toEqual([
            { path: 'wallet.json', rule: 'forbidden-wallet-artifact' },
        ])
    })

    it('blocks wallet generators and literal EVM private keys', () => {
        const root = fixture()
        mkdirSync(join(root, 'src'))
        writeFileSync(join(root, 'src', 'generator.py'), 'from eth_account import Account\n')
        writeFileSync(join(root, 'src', 'fixture.json'), JSON.stringify({ private_key: 'a'.repeat(64) }))
        expect(scanSourceForWalletMaterial(root)).toEqual(expect.arrayContaining([
            { path: 'src/generator.py', rule: 'wallet-generator' },
            { path: 'src/fixture.json', rule: 'literal-evm-private-key' },
        ]))
    })

    it('does not confuse hashes or mesh signing code with wallets', () => {
        const root = fixture()
        mkdirSync(join(root, 'src'))
        writeFileSync(join(root, 'src', 'hashes.txt'), 'a'.repeat(64))
        writeFileSync(join(root, 'src', 'mesh.ts'), 'const privateKey = loadNodeIdentity()')
        expect(scanSourceForWalletMaterial(root)).toEqual([])
    })
})

describe('dependency audit evidence', () => {
    it('does not turn registry failures into zero vulnerabilities', () => {
        for (const report of [{}, { error: { code: 'ENOAUDIT' } }, { metadata: { vulnerabilities: {} } }]) {
            expect(() => parseDependencyAudit(JSON.stringify(report))).toThrow()
        }
        const counts = { critical: 0, high: 1, moderate: 2, low: 0, total: 3 }
        expect(parseDependencyAudit(JSON.stringify({ metadata: { vulnerabilities: counts } }))).toEqual(counts)
    })
})
