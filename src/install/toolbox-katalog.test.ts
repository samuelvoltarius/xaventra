import { describe, expect, it } from 'vitest'
import { findCatalogEntry, getInstallCatalog, loadInstallCatalog, OLLAMA, TEST_BIN, APT_GET } from './install-catalog.js'
import { planInstallRoute } from './install-queue.js'
import { findSoftwareCandidate, getSoftwareCandidates } from './software-candidates.js'

// 2.85 Paket D: the toolbox extends the signed catalog only where the existing
// routes (apt on the host agent / image, Ollama model, runtime add-on) give a clean
// install, verify and rollback — never curl|sh, never a free command.

describe('Werkzeugkasten: Katalog-Erweiterung', () => {
    it('Tesseract OCR (Deutsch + Englisch) is an apt entry in fixed form with verify and apt rollback', () => {
        const entry = findCatalogEntry('tesseract-ocr')
        expect(entry).toBeDefined()
        expect(entry).toMatchObject({
            kind: 'apt', targets: ['host-agent', 'image'], packages: ['tesseract-ocr', 'tesseract-ocr-deu'],
            install: [APT_GET, 'install', '-y', '--no-install-recommends', 'tesseract-ocr', 'tesseract-ocr-deu'],
            verify: [[TEST_BIN, '-x', '/usr/bin/tesseract']], rollback: { kind: 'apt-remove-new' }, approval: 'fragen', runAs: 'root',
        })
    })

    it('Gemma 4 E2B (vision) is an Ollama model: the id carries no tag, the pull/show/rm reference does', () => {
        const entry = findCatalogEntry('ollama-model:gemma4-e2b')
        expect(entry).toBeDefined()
        expect(entry!.install).toEqual([OLLAMA, 'pull', 'gemma4:e2b'])
        expect(entry!.verify).toEqual([[OLLAMA, 'show', 'gemma4:e2b']])
        expect(entry!.rollback).toEqual({ kind: 'command', argv: [OLLAMA, 'rm', 'gemma4:e2b'] })
        expect(entry!.runAs).toBe('service')
        // A worker gets the model reference with tag, not the catalog id.
        const route = planInstallRoute(entry, { nodeId: 'ns1', installPath: 'image', role: 'worker', local: false })
        expect(route).toMatchObject({ kind: 'model-volume', model: 'gemma4:e2b' })
    })

    it('a model entry whose pull reference does not match its fixed reference is refused', () => {
        const gemma = structuredClone(findCatalogEntry('ollama-model:gemma4-e2b')!)
        const swapped = { ...gemma, install: [OLLAMA, 'pull', 'gemma4:31b'] }
        expect(loadInstallCatalog([swapped]).rejected[0]?.reason).toMatch(/feste/)
    })

    it('every catalog entry is offered by a candidate (so the toolbox shows it with capability and benefit)', () => {
        const candidates = getSoftwareCandidates()
        expect(candidates.rejected).toEqual([])
        const offered = new Set(candidates.entries.map(entry => entry.catalogId).filter(Boolean))
        for (const entry of getInstallCatalog().entries) expect(offered.has(entry.id), entry.id).toBe(true)
        expect(findSoftwareCandidate('vision-gemma4-e2b')?.catalogId).toBe('ollama-model:gemma4-e2b')
        expect(findSoftwareCandidate('vision-tesseract-ocr')?.catalogId).toBe('tesseract-ocr')
        expect(findSoftwareCandidate('embedding-mxbai-embed-large')?.catalogId).toBe('ollama-model:mxbai-embed-large')
    })

    it('SearXNG, Piper and faster-whisper stay visible without a catalog id (no container/pip route yet)', () => {
        expect(findSoftwareCandidate('search-searxng')?.capability).toBe('search')
        expect(findSoftwareCandidate('search-searxng')?.catalogId).toBeUndefined()
        expect(findSoftwareCandidate('tts-piper')?.catalogId).toBeUndefined()
        expect(findSoftwareCandidate('stt-faster-whisper-small')?.catalogId).toBeUndefined()
    })

    it('every candidate carries a plain one-sentence benefit for the toolbox', () => {
        for (const entry of getSoftwareCandidates().entries) {
            expect(entry.nutzen, entry.id).toMatch(/^[A-ZÄÖÜ].{8,118}\.$/)
            expect(entry.nutzen, entry.id).not.toMatch(/\b(?:STT|TTS|LLM|GPU|Ollama|Embedding|apt|vLLM)\b/)
        }
    })
})
