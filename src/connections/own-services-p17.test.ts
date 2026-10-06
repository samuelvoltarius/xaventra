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
})
