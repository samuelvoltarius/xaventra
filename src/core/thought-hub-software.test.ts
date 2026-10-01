import { describe, expect, it, vi } from 'vitest'

// Stufe-2 path mocked: the scout may only reach proposeCatalogInstall (queue), never a ticket.
const queue = vi.hoisted(() => ({
    proposeCatalogInstall: vi.fn(() => ({ ok: true, message: 'iq-0123456789ab: ffmpeg auf xaventra-spark wartet auf Freigabe.', proposal: { status: 'queued' } })),
    approveQueuedInstall: vi.fn(),
    autoApproveIfAllowed: vi.fn(),
    resolveInstallTarget: vi.fn(async (nodeId: string) => ({ nodeId, installPath: 'host-agent', role: 'main', local: true, platform: 'linux', arch: 'arm64' })),
    defaultInstallDeps: vi.fn(() => ({ dataDir: 'mock-data' })),
    isModelOnlyNode: vi.fn(() => false),
    planInstallRoute: vi.fn(),
}))
vi.mock('../install/install-queue.js', () => queue)

const { listThoughts } = await import('../planner/index.js')
const { createSoftwareScoutThoughtSink, dispatchThoughtAnswer } = await import('./thought-hub.js')

const gap = (over: Record<string, unknown> = {}) => ({
    kind: 'software-scout:luecke', capability: 'media', candidateId: 'media-ffmpeg', nodeId: 'xaventra-spark',
    title: 'ffmpeg passt auf xaventra-spark (42 GB frei). Einrichten?', text: 'Audio/Video fehlt im Mesh.', evidence: ['Profil xaventra-spark'],
    proposal: 'In die Installations-Warteschlange (Katalog ffmpeg).', permission: 'fragen', dedupeKey: 'software-scout:media:media-ffmpeg:xaventra-spark', ...over,
})
const OWNER = { userId: '1000000001' }

describe('Software-Scout → Gedanke → Knopf → nur Stufe-2-Weg', () => {
    it('a gap becomes a planner thought with permission fragen', async () => {
        await createSoftwareScoutThoughtSink().emit(gap())
        const thought = listThoughts().find(item => item.title.startsWith('ffmpeg passt'))!
        expect(thought.permission).toBe('fragen')
        expect(thought.source).toBe('software-scout')
        expect(thought.kind).toBe('vorschlag')
    })

    it('Ja with a catalog id goes exactly through the Stufe-2 queue (no ticket, no approval here)', async () => {
        const thought = listThoughts().find(item => item.title.startsWith('ffmpeg passt'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', OWNER)
        expect(result.ok).toBe(true)
        expect(queue.proposeCatalogInstall).toHaveBeenCalledTimes(1)
        expect(queue.proposeCatalogInstall).toHaveBeenCalledWith('ffmpeg', expect.objectContaining({ nodeId: 'xaventra-spark' }), { dataDir: 'mock-data' }, 'scan')
        expect(queue.approveQueuedInstall).not.toHaveBeenCalled()
        expect(queue.autoApproveIfAllowed).not.toHaveBeenCalled()
        expect(result.message).toMatch(/Installations-Karte/)
    })

    it('Ja without a catalog id installs nothing, only notes "Katalogeintrag nötig"', async () => {
        queue.proposeCatalogInstall.mockClear()
        queue.resolveInstallTarget.mockClear()
        await createSoftwareScoutThoughtSink().emit(gap({ capability: 'stt', candidateId: 'stt-whisper-large-v3', title: 'Whisper large-v3 (GPU) passt auf xaventra-spark. Einrichten?', dedupeKey: 'software-scout:stt:stt-whisper-large-v3:xaventra-spark' }))
        const thought = listThoughts().find(item => item.title.startsWith('Whisper large-v3'))!
        const result = await dispatchThoughtAnswer(thought.id, 'ja', OWNER)
        expect(result.message).toMatch(/Katalogeintrag nötig/)
        expect(queue.proposeCatalogInstall).not.toHaveBeenCalled()
        expect(queue.resolveInstallTarget).not.toHaveBeenCalled()
    })

    it('a catalog id smuggled into the thought is ignored; the candidate catalog decides', async () => {
        queue.proposeCatalogInstall.mockClear()
        await createSoftwareScoutThoughtSink().emit(gap({ candidateId: 'tts-piper', catalogId: 'xfce-workstation', title: 'Piper passt. Einrichten?', dedupeKey: 'software-scout:tts:tts-piper:xaventra-spark' }))
        const thought = listThoughts().find(item => item.title.startsWith('Piper passt'))!
        await dispatchThoughtAnswer(thought.id, 'ja', OWNER)
        expect(queue.proposeCatalogInstall).not.toHaveBeenCalled()
    })

    it('an unknown candidate id stores no action: Ja does nothing', async () => {
        queue.proposeCatalogInstall.mockClear()
        await createSoftwareScoutThoughtSink().emit(gap({ candidateId: 'rm-rf', title: 'Unbekannt passt. Einrichten?', dedupeKey: 'software-scout:x:rm-rf:n' }))
        const thought = listThoughts().find(item => item.title.startsWith('Unbekannt passt'))!
        await dispatchThoughtAnswer(thought.id, 'ja', OWNER)
        expect(queue.proposeCatalogInstall).not.toHaveBeenCalled()
    })

    it('Nein queues nothing', async () => {
        queue.proposeCatalogInstall.mockClear()
        await createSoftwareScoutThoughtSink().emit(gap({ candidateId: 'browser-playwright-chromium', title: 'Playwright passt. Einrichten?', dedupeKey: 'software-scout:browser:browser-playwright-chromium:xaventra-spark' }))
        const thought = listThoughts().find(item => item.title.startsWith('Playwright passt'))!
        const result = await dispatchThoughtAnswer(thought.id, 'nein', OWNER)
        expect(result.message).toMatch(/30 Tage/)
        expect(queue.proposeCatalogInstall).not.toHaveBeenCalled()
    })
})
