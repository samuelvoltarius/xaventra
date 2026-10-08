/**
 * 2.89.4 Fix 5 over the real entry (createDaemonMessageEntry → slash-commands
 * /status, Telegram and Desktop input):
 * /status showed ghost nodes and dead endpoints. Only real mesh nodes (heartbeat
 * evidence or this node itself) are listed; the Desktop node-list freshness rule
 * (isHeartbeatFresh) decides online/offline; an AI endpoint is listed as working
 * only when reachable, otherwise marked „nicht erreichbar“; guessed-from-peer
 * phantom rows never appear.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'

let h: E2EHarness | undefined
afterEach(async () => {
    await h?.close(); h = undefined
    delete process.env.NOVA_NODE_ID
})
const T = 90_000

const LOCAL = 'nova-e2e-main'
const LIVE_NODE = 'nova-e2e-live'
const GHOST_NODE = 'nova-e2e-ghost'
const PHANTOM_NODE = 'nova-e2e-phantom'
const LIVE_ENDPOINT = '192.0.2.10:8000'
const DEAD_ENDPOINT = '192.0.2.10:11434'
const HEARSAY_ENDPOINT = '192.0.2.99:8000'
const GHOST_ENDPOINT = '192.0.2.20:8000'
const PHANTOM_ENDPOINT = '192.0.2.30:8000'

function seedGraph(root: string): void {
    process.env.NOVA_NODE_ID = LOCAL
    const now = Date.now()
    const fresh = () => new Date(now - 30_000).toISOString()
    const stale = () => new Date(now - 10 * 60_000).toISOString()
    mkdirSync(join(root, '.nova-data'), { recursive: true })
    writeFileSync(join(root, '.nova-data', 'capability-graph.json'), JSON.stringify({
        version: 1,
        updatedAt: fresh(),
        tombstones: [],
        nodes: [
            {
                id: LIVE_NODE, hostname: 'live', host: '192.0.2.10', status: 'online',
                lastHeartbeat: fresh(), updatedAt: fresh(), capabilities: ['llm'],
                software: {
                    node_version: 'v22', package_managers: [], can_install: [],
                    ai_services: [
                        { name: 'vllm', type: 'llm', endpoint: `http://${LIVE_ENDPOINT}`, status: 'running', models: ['qwen'] },
                        // advertised, but the last verification is older than the offline window
                        { name: 'ollama', type: 'llm', endpoint: `http://${DEAD_ENDPOINT}`, status: 'running', models: ['llama3'] },
                    ],
                },
                runtimes: [
                    {
                        id: `${LIVE_NODE}:vllm:live`, name: 'vllm', type: 'llm', endpoint: `http://${LIVE_ENDPOINT}`,
                        status: 'running', models: ['qwen'], capabilities: ['llm', 'vllm'],
                        verifiedAt: fresh(), verificationSource: 'probe',
                    },
                    {
                        // running, but the evidence is older than the offline window
                        id: `${LIVE_NODE}:ollama:dead`, name: 'ollama', type: 'llm', endpoint: `http://${DEAD_ENDPOINT}`,
                        status: 'running', models: ['llama3'], capabilities: ['llm'],
                        verifiedAt: stale(), verificationSource: 'probe',
                    },
                    {
                        // peer hearsay: the node no longer advertises this runtime
                        id: `${LIVE_NODE}:vllm:hearsay`, name: 'vllm', type: 'llm', endpoint: `http://${HEARSAY_ENDPOINT}`,
                        status: 'running', models: ['qwen'], capabilities: ['llm'],
                        verifiedAt: fresh(), verificationSource: 'mesh-heartbeat',
                    },
                ],
            },
            {
                // ghost: deleted worker, stored status still "online", heartbeat stale
                id: GHOST_NODE, hostname: 'ghost', host: '192.0.2.20', status: 'online',
                lastHeartbeat: stale(), updatedAt: fresh(), capabilities: [],
                runtimes: [{
                    id: `${GHOST_NODE}:vllm`, name: 'vllm', type: 'llm', endpoint: `http://${GHOST_ENDPOINT}`,
                    status: 'running', models: ['qwen'], capabilities: ['llm'],
                    verifiedAt: stale(), verificationSource: 'probe',
                }],
            },
            {
                // guessed-from-peer / scanner host row: no heartbeat at all
                id: PHANTOM_NODE, hostname: 'phantom', host: '192.0.2.30', status: 'unknown',
                updatedAt: fresh(), capabilities: [],
                runtimes: [{
                    id: `${PHANTOM_NODE}:vllm`, name: 'vllm', type: 'llm', endpoint: `http://${PHANTOM_ENDPOINT}`,
                    status: 'running', models: ['qwen'], capabilities: ['llm'],
                    verifiedAt: fresh(), verificationSource: 'probe',
                }],
            },
        ],
    }, null, 2))
}

function expectGhostFree(text: string): void {
    // Real fresh node and its reachable endpoint (no "nicht erreichbar" on that line).
    expect(text).toContain(LIVE_NODE)
    const liveLine = text.split('\n').find(line => line.includes(LIVE_ENDPOINT)) || ''
    expect(liveLine).toContain('qwen')
    expect(liveLine).not.toContain('nicht erreichbar')
    // Dead endpoint is marked, never shown as working.
    expect(text).toContain(DEAD_ENDPOINT)
    expect(text).toMatch(/nicht erreichbar/)
    // Peer-hearsay runtime is gone.
    expect(text).not.toContain(HEARSAY_ENDPOINT)
    // Ghost node (stale heartbeat) is offline, whatever the stored status says.
    expect(text).toContain(`${GHOST_NODE} (offline)`)
    // Guessed-from-peer row is never listed.
    expect(text).not.toContain(PHANTOM_NODE)
    expect(text).not.toContain(PHANTOM_ENDPOINT)
}

describe('2.89.4 /status ghost nodes and dead endpoints (real entry)', () => {
    it('Desktop /status: only real mesh nodes, dead endpoints marked, no phantom rows', async () => {
        h = await createE2EHarness({ seed: seedGraph })
        const result = await h.desktop('/status')
        expect(result.error).toBeUndefined()
        expectGhostFree(result.final)
    }, T)

    it('Telegram /status: the same inventory in the status card', async () => {
        h = await createE2EHarness({ seed: seedGraph })
        const result = await h.telegram('/status')
        expect(result.error).toBeUndefined()
        const text = [result.final, ...result.buttons.map(button => button.text)].join('\n')
        expectGhostFree(text)
    }, T)
})
