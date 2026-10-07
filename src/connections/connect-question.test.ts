import { describe, expect, it } from 'vitest'
import { answerConnectQuestion, connectQuestionTarget } from './connect-question.js'

// 2.88.2 (live 07.10.2026): "searxng kannst du dich mit dem verbinen ?" — SearXNG was
// listed as connected under Verbindungen, yet she asked the owner for a URL.

const entries = [
    { title: 'SearXNG auf diesem Rechner', verbunden: true },
    { title: 'Home Assistant', verbunden: true },
    { title: 'Tuya-Gerät', verbunden: false },
]

describe('"Kannst du dich mit X verbinden?" answers from the own connection list', () => {
    it.each([
        ['searxng kannst du dich mit dem verbinen ?', 'searxng'],
        ['Kannst du dich mit Home Assistant verbinden?', 'home assistant'],
        ['verbinde dich mit searxng', 'searxng'],
    ])('reads the target from %s', (text, target) => {
        expect(connectQuestionTarget(text)).toBe(target)
    })
    it('already connected → says so at once', () => {
        expect(answerConnectQuestion('searxng kannst du dich mit dem verbinen ?', entries)).toMatch(/^Ja — SearXNG auf diesem Rechner ist schon verbunden/)
    })
    it('found but not connected, or unknown → normal path (Gegenprobe)', () => {
        expect(answerConnectQuestion('Kannst du dich mit Tuya verbinden?', entries)).toBeNull()
        expect(answerConnectQuestion('Kannst du dich mit Spotify verbinden?', entries)).toBeNull()
        expect(answerConnectQuestion('Wie wird das Wetter?', entries)).toBeNull()
    })
})
