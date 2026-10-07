/**
 * 2.89 Paket B, Punkt 3 — Karten schließen sich selbst.
 * isStillOpen is required for every executor; the executors that had none now say when
 * their card is settled; the builtin wiring is „registered“ only after every group
 * succeeded. Live way: the real registration and the real card store.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApprovalCard, getCardExecutor, maintainApprovalCards, registerCardExecutor, type ApprovalCard } from './approval-cards.js'
import { ensureBuiltinCardExecutors } from './approval-card-sources.js'
import { createTelefonCardExecutor, neuerAnrufPlan } from '../voice/telefon-ausgang.js'
import { createOllamaPullExecutor, requestOllamaPull } from '../routing/local-model-control.js'
import { createReleasePromoteExecutor } from './release-button.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-open-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const card = (kind: string, ref: string): ApprovalCard => ({ aktion: { kind, ref } } as ApprovalCard)

describe('2.89 B3: isStillOpen ist Pflicht', () => {
    it('an executor without isStillOpen is refused at registration', () => {
        expect(() => registerCardExecutor({ kind: 'test-ohne-stand', async execute() { return { ok: true, message: '' } } } as any)).toThrow(/isStillOpen/)
        expect(getCardExecutor('test-ohne-stand')).toBeUndefined()
    })

    it('every builtin executor of the production wiring has isStillOpen', async () => {
        const { failed } = await ensureBuiltinCardExecutors()
        expect(failed).toEqual([])
        for (const kind of ['install', 'install-rollback', 'self-heal', 'self-heal-peer', 'patch', 'verbindung-herstellen', 'geraet-verbinden', 'tresor-freigabe', 'telefon-anruf', 'ollama-pull', 'vllm-wechsel', 'lernen']) {
            const executor = getCardExecutor(kind)
            if (executor) expect(typeof executor.isStillOpen, kind).toBe('function')
        }
    })
})

describe('2.89 B3: builtinsRegistered erst nach Erfolg', () => {
    it('a failing group is reported on its own, the others are registered, the next call tries again', async () => {
        let calls = 0
        const groups = [
            { name: 'kaputt', register: () => { calls++; if (calls === 1) throw new Error('Import fehlgeschlagen') } },
            { name: 'gut', register: () => registerCardExecutor({ kind: 'test-gruppe-gut', isStillOpen: () => true, async execute() { return { ok: true, message: '' } } }) },
        ]
        expect((await ensureBuiltinCardExecutors(groups)).failed).toEqual(['kaputt'])
        expect(getCardExecutor('test-gruppe-gut')).toBeDefined()
        expect((await ensureBuiltinCardExecutors(groups)).failed).toEqual([])
        expect(calls).toBe(2)
    })
})

describe('2.89 B3: Karten schließen sich selbst', () => {
    it('Telefon: the card closes once its call plan is gone', async () => {
        const dir = tmp()
        const executor = createTelefonCardExecutor({ opts: { dataDir: dir } })
        const plan = neuerAnrufPlan('+15555550123', { dataDir: dir })
        expect(executor.isStillOpen(card('telefon-anruf', plan.id))).toBe(true)
        await executor.reject!(card('telefon-anruf', plan.id), { decidedBy: 'x', userId: 'x' })
        expect(executor.isStillOpen(card('telefon-anruf', plan.id))).toBe(false)
    })

    it('Ollama-Pull: closed once the request is no longer open; the real maintenance retires the card', async () => {
        const dir = tmp()
        const opts = { dataDir: dir, ledger: null }
        const executor = createOllamaPullExecutor({ port: { pull: async () => undefined } as any, dataDir: dir })
        registerCardExecutor(executor)
        const result = requestOllamaPull({ node: 'gpu-1', baseUrl: 'http://192.0.2.20:11434', model: 'example-model', taskClass: 'chat' } as any, opts)
        expect(result.ok).toBe(true)
        const id = (result as any).card.id
        expect(maintainApprovalCards(opts).settled).toEqual([])
        await executor.reject!((result as any).card, { decidedBy: 'x', userId: 'x' })
        expect(maintainApprovalCards(opts).settled.map(item => item.id)).toEqual([id])
    })

    it('Release: closed once this commit was dispatched', () => {
        const dir = tmp()
        const statePath = join(dir, 'release-state.json')
        const executor = createReleasePromoteExecutor({ statePath, settings: () => ({ enabled: true }) } as any)
        const sha = 'a'.repeat(40)
        expect(executor.isStillOpen(card('release-promote', `2.89.0@${sha}`))).toBe(true)
        writeFileSync(statePath, JSON.stringify({ dispatched: { [sha]: { at: '2026-10-07T10:00:00Z', version: '2.89.0' } } }))
        expect(executor.isStillOpen(card('release-promote', `2.89.0@${sha}`))).toBe(false)
        expect(executor.isStillOpen(card('release-promote', 'kaputt'))).toBe(false)
    })

    it('a card whose executor says „settled“ is not executed on the press (Gegenprobe: open card runs)', async () => {
        const dir = tmp()
        const opts = { dataDir: dir, ledger: null }
        let ran = 0
        let open = true
        registerCardExecutor({ kind: 'test-erledigt', isStillOpen: () => open, async execute() { ran++; return { ok: true, message: 'lief' } } })
        const { answerApprovalCard } = await import('./approval-cards.js')
        const make = () => createApprovalCard({ art: 'test', titel: 'Test?', beleg: 'b', vorschlag: 'v', aktion: { kind: 'test-erledigt', ref: `r${Math.random().toString(16).slice(2, 10)}` } }, opts)
        const first = make() as any
        expect((await answerApprovalCard(`ac:${first.card.buttons[0].token}`, { userId: '1', ownerIds: ['1'] }, opts)).ok).toBe(true)
        open = false
        const second = make() as any
        const answer = await answerApprovalCard(`ac:${second.card.buttons[0].token}`, { userId: '1', ownerIds: ['1'] }, opts)
        expect(answer.ok).toBe(false)
        expect(answer.card?.status).toBe('erledigt')
        expect(ran).toBe(1)
    })
})
