import { describe, expect, it } from 'vitest'
import { findeLoesung } from './stuck-helper.js'

// 2.91.1 (integration of the vault change): a connection whose sealed access data cannot be opened (status
// `schluessel-fehlt`) is the answer to "ich komm nicht weiter" - never a request to sign in again, nothing deleted.
// `nicht-erreichbar` (B3) keeps its own sentence.
describe('stuck helper knows both connection states', () => {
    it('schluessel-fehlt: the key is missing, nothing deleted, no new login', () => {
        const answer = findeLoesung({ verbindungen: [{ id: 'ha', title: 'Home Assistant', status: 'schluessel-fehlt' }] } as any)
        expect(answer?.satz).toMatch(/Schlüssel fehlt/)
        expect(answer?.satz).toMatch(/nichts gelöscht/)
        expect(answer?.satz).not.toMatch(/neu an|abgelaufen/)
    })
    it('nicht-erreichbar keeps its sentence', () => {
        const answer = findeLoesung({ verbindungen: [{ id: 'ha', title: 'Home Assistant', status: 'nicht-erreichbar' }] } as any)
        expect(answer?.satz).toMatch(/nicht erreichbar/)
    })
})
