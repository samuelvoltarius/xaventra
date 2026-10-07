import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
    AKTIONSARTEN, evaluateAction, isNieAktionsart, NIE_EFFEKTE, nieListeUebersicht, recordActionOutcome,
    TRUST_MIN_SUCCESSES, trustEvidence, trustUpgradeProposal,
} from './action-policy.js'
import { createApprovalCard, registerCardExecutor } from './approval-cards.js'
import { NIE_LISTE } from '../doctor/self-heal.js'
import { isPhysischOderExtern, nieEffekt } from './action-policy.js'

// The former learning-module helpers (thinking/decision-learning.ts) were thin
// wrappers over the action policy; the policy is the single source now.
const isNeverKind = (kind: string) => nieEffekt(kind) !== null || isNieAktionsart(kind)
const isPhysicalOrExternalKind = (kind: string) => isPhysischOderExtern(kind)

// Phase 6b: one action policy for every part. Each guard has a Gegenprobe
// (take the guard back -> this file turns red), see the branch report.

describe('evaluateAction — levels', () => {
    it('unknown action kind -> L2 ask (fail-safe)', () => {
        const verdict = evaluateAction({ kind: 'irgendwas-neues', origin: 'mission' })
        expect(verdict).toMatchObject({ level: 'L2', decision: 'ask', known: false })
        expect(verdict.reason).toContain('unbekannte Aktionsart')
    })

    it('unknown effect on a known L0 kind -> L2 ask', () => {
        expect(evaluateAction({ kind: 'diagnose', effects: ['quanten:verschraenken'], origin: 'mission' })).toMatchObject({ level: 'L2', decision: 'ask' })
    })

    it('L0 reading and L1 own maintenance run automatically', () => {
        expect(evaluateAction({ kind: 'diagnose', origin: 'mission' })).toMatchObject({ level: 'L0', decision: 'auto' })
        for (const kind of ['log-rotation', 'cache-leeren', 'endpoint-umschalten', 'self-heal-zyklus']) {
            expect(evaluateAction({ kind, origin: 'selbstheilung' }), kind).toMatchObject({ level: 'L1', decision: 'auto' })
        }
    })

    it('L1 on a foreign node becomes L2 ask', () => {
        expect(evaluateAction({ kind: 'cache-leeren', node: 'worker-b', origin: 'mission' }, { localNodeId: 'main-a' })).toMatchObject({ level: 'L2', decision: 'ask' })
        expect(evaluateAction({ kind: 'cache-leeren', node: 'main-a', origin: 'mission' }, { localNodeId: 'main-a' })).toMatchObject({ level: 'L1', decision: 'auto' })
    })

    it('consequential actions are L2 ask', () => {
        for (const kind of ['install-katalog', 'dienst-neustart', 'config-aendern', 'geraet-einrichten', 'modell-wechseln', 'vm-starten', 'vm-stoppen', 'vm-snapshot', 'drucken', 'schalten', 'mail-senden']) {
            expect(evaluateAction({ kind, origin: 'mission' }), kind).toMatchObject({ level: 'L2', decision: 'ask' })
        }
    })

    it('physical or outward unknown kinds are at least L2 and marked as such', () => {
        expect(evaluateAction({ kind: 'drucker-naechster-job', origin: 'wahrnehmen' })).toMatchObject({ level: 'L2', impact: 'physisch' })
        expect(evaluateAction({ kind: 'antwort-senden', origin: 'denken' })).toMatchObject({ level: 'L2', impact: 'extern' })
        expect(evaluateAction({ kind: 'diagnose', effects: ['physisch:drucken'], origin: 'mission' })).toMatchObject({ level: 'L2', impact: 'physisch' })
    })

    it('table invariant: every physical/outward kind is at least L2', () => {
        for (const [kind, entry] of Object.entries(AKTIONSARTEN)) {
            if (entry.impact !== 'intern') expect(['L2', 'L3'], kind).toContain(evaluateAction({ kind, origin: 'code' }).level)
        }
    })

    it('the model can never set the level', () => {
        const verdict = evaluateAction({ kind: 'install-katalog', origin: 'model', level: 'L0', decision: 'auto' })
        expect(verdict).toMatchObject({ level: 'L2', decision: 'ask' })
        const never = evaluateAction({ kind: 'daten-loeschen', origin: 'model', level: 'L1', decision: 'auto' } as any)
        expect(never).toMatchObject({ level: 'L3', decision: 'never' })
    })
})

describe('evaluateAction — L3 never automatic, never a button', () => {
    it('Nie-Liste effects, kinds, targets and commands are L3', () => {
        expect(evaluateAction({ kind: 'cache-leeren', effects: ['daten:loeschen'], origin: 'mission' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'firewall-aendern', origin: 'mission' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'nas-neustart', origin: 'verantwortung' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'db-migration', origin: 'mission' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'sicherheit-abschalten', origin: 'mission' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'credentials-aendern', origin: 'mission' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'log-rotation', target: 'config/.env', origin: 'selbstheilung' })).toMatchObject({ level: 'L3', decision: 'never' })
        expect(evaluateAction({ kind: 'install-katalog', argv: ['rm', '-rf', '/srv/data'], origin: 'mission' })).toMatchObject({ level: 'L3', decision: 'never' })
    })

    it('an owner request for an L3 action is a handoff, never auto', () => {
        const verdict = evaluateAction({ kind: 'sudoers-aendern', origin: 'owner' })
        expect(verdict).toMatchObject({ level: 'L3', decision: 'handoff' })
        for (const origin of ['owner', 'mission', 'model', 'code', 'verantwortung']) {
            expect(evaluateAction({ kind: 'daten-loeschen', origin }).decision, origin).not.toBe('auto')
            expect(evaluateAction({ kind: 'daten-loeschen', origin }).decision, origin).not.toBe('ask')
        }
    })

    it('every explicitly listed L3 kind is refused as a card and as a card executor', () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'policy-cards-'))
        for (const [kind, entry] of Object.entries(AKTIONSARTEN)) {
            if (entry.level !== 'L3') continue
            const card = createApprovalCard({ art: kind, titel: kind, beleg: '-', vorschlag: '-', aktion: { kind, ref: 'x1' } }, { dataDir, ledger: null })
            expect(card.ok, kind).toBe(false)
            expect(() => registerCardExecutor({ isStillOpen: () => true, kind, async execute() { return { ok: true, message: '' } } }), kind).toThrow(/Nie-Liste/)
        }
    })
})

describe('unified Nie-Liste — never looser than the old lists', () => {
    it('self-heal keeps exporting the same list (now from the core)', () => {
        expect(NIE_LISTE).toBe(NIE_EFFEKTE)
        expect(NIE_LISTE.map(item => item.effect)).toEqual(expect.arrayContaining([
            'nas:neustart', 'nas:shutdown', 'daten:loeschen', 'backup:loeschen', 'rollback-container:loeschen', 'db:migration', 'db:schreiben',
            'telegram:nicht-main', 'firewall:aendern', 'ssh:aendern', 'tailscale:aendern', 'sudoers:aendern', 'secrets:lesen', 'secrets:verschieben',
            'secrets:ausgeben', 'fremddienst:aendern', 'vllm:stoppen', 'kernel:aendern', 'treiber:aendern', 'cuda:aendern', 'apt:upgrade',
            'apt:dist-upgrade', 'curl-pipe-sh', 'shell:ausfuehren', 'ssh:ausfuehren', 'root:werden',
        ]))
    })

    it('kinds from the old card list and the old learning list are both never', () => {
        // old card list
        for (const kind of ['daten-loeschen', 'nas-reboot', 'db-migration', 'tailscale-up', 'kernel-update', 'curl-pipe', 'vllm-stoppen', 'telegram-nicht-main']) {
            expect(isNieAktionsart(kind), kind).toBe(true)
            expect(isNeverKind(kind), kind).toBe(true)
        }
        // old learning list (now also refused as a card: stricter, never looser)
        for (const kind of ['dateien-entfernen', 'ssh:login', 'sudo-run', 'private-key-export']) {
            expect(isNieAktionsart(kind), kind).toBe(true)
            const card = createApprovalCard({ art: 'x-test', titel: kind, beleg: '-', vorschlag: '-', aktion: { kind: kind.replace(/[^a-z-]/g, '-'), ref: 'x1' } }, { dataDir: mkdtempSync(join(tmpdir(), 'policy-nie-')), ledger: null })
            expect(card.ok, kind).toBe(false)
        }
    })

    it('physical/outward detection is the union of both old lists', () => {
        for (const kind of ['drucken', 'licht-an', 'mail-senden', 'kaufen', 'slice-modell', 'garage-auf', 'whatsapp-antwort', 'abo-buchen']) {
            expect(isPhysicalOrExternalKind(kind), kind).toBe(true)
        }
        expect(isPhysicalOrExternalKind('installieren:ffmpeg')).toBe(false)
    })

    it('one overview of all sources', () => {
        const overview = nieListeUebersicht()
        expect(overview.effekte.length).toBe(NIE_EFFEKTE.length)
        expect(overview.befehlsregeln).toEqual(expect.arrayContaining(['shell-pipe', 'privilege', 'data-deletion', 'secrets']))
        expect(overview.aktionsarten).toBeGreaterThan(10)
    })
})

describe('trust ladder (prepared, never automatic)', () => {
    it('counts successes without rollback; a rollback resets the series', () => {
        const opts = { dataDir: mkdtempSync(join(tmpdir(), 'policy-trust-')) }
        recordActionOutcome('install-katalog', { ok: true }, opts)
        recordActionOutcome('install-katalog', { ok: true }, opts)
        expect(trustEvidence('install-katalog', opts)).toMatchObject({ successes: 2, total: 2 })
        recordActionOutcome('install-katalog', { ok: true, rolledBack: true }, opts)
        expect(trustEvidence('install-katalog', opts)).toMatchObject({ successes: 0, total: 3 })
    })

    it('proposes L2 -> L1 only as text, once per series, and never changes the level', () => {
        const opts = { dataDir: mkdtempSync(join(tmpdir(), 'policy-trust-')) }
        for (let i = 0; i < TRUST_MIN_SUCCESSES - 1; i++) recordActionOutcome('install-katalog', { ok: true }, opts)
        expect(trustUpgradeProposal('install-katalog', opts)).toBeNull()
        recordActionOutcome('install-katalog', { ok: true }, opts)
        const proposal = trustUpgradeProposal('install-katalog', opts)
        expect(proposal?.text).toContain('Umstellen kann nur Alfred')
        expect(trustUpgradeProposal('install-katalog', opts)).toBeNull()
        expect(evaluateAction({ kind: 'install-katalog', origin: 'mission' }).level).toBe('L2')
    })

    it('never proposes for physical, outward or L3 kinds', () => {
        const opts = { dataDir: mkdtempSync(join(tmpdir(), 'policy-trust-')) }
        for (const kind of ['drucken', 'schalten', 'mail-senden', 'daten-loeschen', 'firewall-aendern']) {
            for (let i = 0; i < 10; i++) recordActionOutcome(kind, { ok: true }, opts)
            expect(trustUpgradeProposal(kind, opts), kind).toBeNull()
        }
    })
})
