import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NUR_EINZELNES_JA, promotedKinds, recordActionOutcome, recordOwnerAnswer } from './action-policy.js'

// Alfred 01.10.2026: the vLLM model switch always needs its own Ja — the trust
// ladder (3× Ja → selbst) must never promote a kind from NUR_EINZELNES_JA.
describe('Vertrauensleiter respektiert „nur einzelnes Ja“', () => {
    it.each([...NUR_EINZELNES_JA])('%s wird nie hochgestuft', kind => {
        const dataDir = mkdtempSync(join(tmpdir(), 'trust-single-'))
        for (let i = 0; i < 6; i++) {
            recordOwnerAnswer(kind, 'ja', { dataDir })
            recordActionOutcome(kind, { ok: true, approvedByOwner: true }, { dataDir })
        }
        expect(promotedKinds({ dataDir }).map(item => item.kind)).not.toContain(kind)
    })
})
