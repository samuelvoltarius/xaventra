/**
 * 2.86.1 Ergänzung a (Owner 06.10. 22:20): eigene Knoten gehören nicht in die
 * GERÄTE-Liste, ihre Dienste werden aber nicht verworfen — sie stehen unter
 * „Verbindungen“ (KI-Modelle / Hilfsdienste) mit Alltagsnamen.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectConnections, type ViewDeps } from './connections-view.js'
import { buildLlmConnectionList } from '../llm/llm-connections.js'

const dirs: string[] = []
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'xv-own-')); dirs.push(dir); return dir }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('2.86.1 a: Dienste eigener Knoten', () => {
    it('stehen nicht unter Geräten, aber mit Alltagsnamen in der Dienste-Liste', async () => {
        const deps: ViewDeps = {
            dataDir: tmp(), directoryCachePath: join(tmp(), 'none.json'), env: {}, accounts: () => [], connections: () => [],
            consolidation: { eigeneAdressen: ['192.0.2.10'], eigeneNetze: ['192.0.2.0/24'], eigeneNamen: ['main-host'] },
            devices: () => [
                { id: 'dev-00000000a1', type: 'networkservice', host: '192.0.2.10', port: 22, via: 'mdns', name: 'main-host SSH', evidence: { service: '_ssh._tcp.local' } },
                { id: 'dev-00000000a2', type: 'n8n', host: '192.0.2.10', port: 5678, via: 'http' },
                { id: 'dev-00000000a3', type: 'homeassistant', host: '192.0.2.30', port: 8123, via: 'http', status: 'gefunden' },
            ],
        }
        const view = await collectConnections(deps)
        const geraete = view.gefunden.filter(item => item.kategorie === 'geraete' || item.kategorie === 'zuhause')
        expect(geraete.map(item => item.title)).toEqual(['Home Assistant'])
        const n8n = view.gefunden.find(item => item.id === 'geraet:n8n:192.0.2.10:5678')
        expect(n8n).toMatchObject({ title: 'Automationen (n8n) auf deinem Rechner' })
        expect(view.gefunden.some(item => /SSH|main-host/.test(item.title))).toBe(false)
    })

    it('Spracherkennung, Sprachausgabe und Bilder eigener Knoten stehen unter Hilfsdienste', () => {
        const list = buildLlmConnectionList({ services: [
            { id: 'whisper-gpu@192.0.2.40:8017', name: 'whisper-gpu', type: 'stt', endpoint: 'http://192.0.2.40:8017', models: ['openai/whisper-large-v3'], status: 'running', sourceNode: 'spark', host: '192.0.2.40' },
            { id: 'comfyui@192.0.2.40:8188', name: 'comfyui', type: 'image', endpoint: 'http://192.0.2.40:8188', models: [], status: 'running', sourceNode: 'spark', host: '192.0.2.40' },
        ] }, null, {}, {})
        expect(list.filter(item => item.datenklasse === 'lokal').map(item => [item.title, item.kategorie])).toEqual([
            ['Spracherkennung auf spark', 'hilfsdienst'], ['Bilder erzeugen auf spark', 'hilfsdienst'],
        ])
    })
    it('one entry for the same service reached as localhost and as the own host name / own address (live 2.88.1 SearXNG)', () => {
        const ownHosts = ['main-host', '203.0.113.7']
        const list = buildLlmConnectionList({ ownHosts, services: [
            { id: 'a', name: 'searxng', type: 'search', endpoint: 'http://127.0.0.1:8888', models: [], status: 'running', sourceNode: 'local', host: '127.0.0.1' },
            { id: 'b', name: 'searxng', type: 'search', endpoint: 'http://main-host:8888', models: [], status: 'running', sourceNode: 'main-host', host: 'main-host' },
            { id: 'c', name: 'searxng', type: 'search', endpoint: 'http://203.0.113.7:8888', models: [], status: 'running', sourceNode: 'main-host', host: '203.0.113.7' },
        ] }, null, {}, {})
        const search = list.filter(item => item.kategorie === 'suche')
        expect(search.map(item => item.title)).toEqual(['SearXNG auf diesem Rechner'])
    })

    it('the same order the other way round still gives one entry named "auf diesem Rechner"', () => {
        const list = buildLlmConnectionList({ ownHosts: ['main-host'], services: [
            { id: 'b', name: 'searxng', type: 'search', endpoint: 'http://main-host:8888', models: [], status: 'running', sourceNode: 'main-host', host: 'main-host' },
            { id: 'a', name: 'searxng', type: 'search', endpoint: 'http://localhost:8888', models: [], status: 'running', sourceNode: 'local', host: 'localhost' },
        ] }, null, {}, {})
        expect(list.filter(item => item.kategorie === 'suche').map(item => item.title)).toEqual(['SearXNG auf diesem Rechner'])
    })

    it('counter-check: a real second instance on another machine, or another port, stays its own entry', () => {
        const list = buildLlmConnectionList({ ownHosts: ['main-host', '203.0.113.7'], services: [
            { id: 'a', name: 'searxng', type: 'search', endpoint: 'http://127.0.0.1:8888', models: [], status: 'running', sourceNode: 'local', host: '127.0.0.1' },
            { id: 'b', name: 'searxng', type: 'search', endpoint: 'http://main-host:8888', models: [], status: 'running', sourceNode: 'main-host', host: 'main-host' },
            { id: 'c', name: 'searxng', type: 'search', endpoint: 'http://198.51.100.9:8888', models: [], status: 'running', sourceNode: 'nas', host: '198.51.100.9' },
            { id: 'd', name: 'searxng', type: 'search', endpoint: 'http://203.0.113.7:8080', models: [], status: 'running', sourceNode: 'main-host', host: '203.0.113.7' },
            { id: 'e', name: 'searxng', type: 'search', endpoint: 'http://198.51.100.10:8888', models: [], status: 'running', sourceNode: 'worker', host: '198.51.100.10' },
        ] }, null, {}, {})
        expect(list.filter(item => item.kategorie === 'suche').map(item => item.title)).toEqual([
            'SearXNG auf diesem Rechner', 'SearXNG auf nas', 'SearXNG auf diesem Rechner', 'SearXNG auf worker',
        ])
    })

    it('helper services (speech) of the own machine are merged the same way', () => {
        const list = buildLlmConnectionList({ ownHosts: ['main-host'], services: [
            { id: 'a', name: 'whisper-gpu', type: 'stt', endpoint: 'http://127.0.0.1:8017', models: [], status: 'running', sourceNode: 'local', host: '127.0.0.1' },
            { id: 'b', name: 'whisper-gpu', type: 'stt', endpoint: 'http://main-host:8017', models: [], status: 'running', sourceNode: 'main-host', host: 'main-host' },
        ] }, null, {}, {})
        expect(list.filter(item => item.kategorie === 'hilfsdienst').map(item => item.title)).toEqual(['Spracherkennung auf diesem Rechner'])
    })
})
