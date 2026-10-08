/**
 * 2.89.4 Fix 4 over the real entry (createDaemonMessageEntry → message-pipeline →
 * runNovaAgent, Telegram input, real tool registry/router, scripted model):
 * Kubernetes/Pod/Cluster questions reach cluster_status; node/pod facts come only
 * from that tool result; never an SSH fallback; without a configured Kubernetes
 * access the answer is honest: „nicht konfiguriert“.
 */
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { createFakeKube, controlPolicyRaw, NS } from '../../test/helpers/fake-kube.js'
import { selfSignedCert } from '../../test/helpers/fake-pve.js'

let h: E2EHarness | undefined
let kubeServer: Server | undefined
const previousTokenFile = process.env.XAVENTRA_K8S_TOKEN_FILE
afterEach(async () => {
    await h?.close(); h = undefined
    await new Promise<void>(resolve => { if (!kubeServer) return resolve(); kubeServer.close(() => resolve()) })
    kubeServer = undefined
    if (previousTokenFile === undefined) delete process.env.XAVENTRA_K8S_TOKEN_FILE
    else process.env.XAVENTRA_K8S_TOKEN_FILE = previousTokenFile
})
const T = 90_000

const ASK = 'Welche Pods laufen im Cluster?'

/** Fake Kubernetes API on loopback (the harness allows localhost TCP). */
async function startFakeKube(): Promise<{ port: number; cert: string; fake: ReturnType<typeof createFakeKube> }> {
    const fake = createFakeKube({ workerNodes: ['node-a', 'node-b'] })
    const { cert, key } = selfSignedCert('localhost')
    kubeServer = createServer({ cert, key }, (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', async () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let body: unknown
            if (raw) { try { body = JSON.parse(raw) } catch { body = undefined } }
            try {
                const response = await fake.transport({
                    method: (req.method || 'GET') as any,
                    path: req.url || '/',
                    body,
                    contentType: req.headers['content-type'] as any,
                })
                res.writeHead(response.status, { 'content-type': 'application/json' })
                res.end(JSON.stringify(response.data ?? null))
            } catch (error) {
                res.writeHead(500, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ message: String((error as Error)?.message || error) }))
            }
        })
    })
    await new Promise<void>(resolve => kubeServer!.listen(0, '127.0.0.1', () => resolve()))
    return { port: (kubeServer.address() as AddressInfo).port, cert, fake }
}

describe('2.89.4 Kubernetes-Fragen (real entry)', () => {
    it('ohne Zugang: ehrlich „nicht konfiguriert“, cluster_status statt SSH', async () => {
        h = await createE2EHarness()
        // The real router of this module graph offers cluster_status and never SSH/shell.
        const router = await h.module('tools/tool-router.js')
        const offered = (router.getRelevantTools(ASK) as Array<{ name: string }>).map(tool => tool.name)
        expect(offered).toContain('cluster_status')
        expect(offered).not.toContain('ssh_command')
        expect(offered).not.toContain('run_command')

        const result = await h.telegram(ASK, [
            { tools: [{ name: 'ssh_command', arguments: { host: 'ns1', command: 'kubectl get pods' } }] },
            { text: 'Ich habe per SSH geprüft: fantasy-pod läuft auf ghost-node.' },
        ])
        expect(result.error).toBeUndefined()
        const text = [result.final, ...result.replies].join('\n')
        expect(text).toMatch(/nicht konfiguriert/i)
        expect(text).not.toMatch(/fantasy-pod|ghost-node/)
        expect(result.executedTools).not.toContain('ssh_command')
        expect(result.executedTools).not.toContain('run_command')
        expect(result.executedTools).toContain('cluster_status')
    }, T)

    it('mit Zugang: Node-/Pod-Fakten nur aus dem Tool-Ergebnis, kein SSH', async () => {
        const { port, cert } = await startFakeKube()
        h = await createE2EHarness({
            seed: root => {
                writeFileSync(join(root, 'ca.crt'), cert)
                writeFileSync(join(root, 'k8s-token'), 'e2e-not-a-real-token')
                writeFileSync(join(root, 'control.json'), JSON.stringify(controlPolicyRaw()))
                const cfg = JSON.parse(readFileSync(join(root, 'xaventra.config.json'), 'utf8'))
                cfg.infra = {
                    kubernetes: {
                        server: `https://localhost:${port}`,
                        caFile: join(root, 'ca.crt'),
                        namespace: NS,
                        release: 'xv',
                        controlFile: join(root, 'control.json'),
                    },
                }
                writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(cfg, null, 2))
                process.env.XAVENTRA_K8S_TOKEN_FILE = join(root, 'k8s-token')
            },
        })
        const router = await h.module('tools/tool-router.js')
        const offered = (router.getRelevantTools(ASK) as Array<{ name: string }>).map(tool => tool.name)
        expect(offered).toContain('cluster_status')

        const result = await h.telegram(ASK, [
            { tools: [{ name: 'ssh_command', arguments: { host: 'ns1', command: 'kubectl get pods' } }] },
            { text: 'Ich habe per SSH geprüft: fantasy-pod läuft auf ghost-node.' },
        ])
        expect(result.error).toBeUndefined()
        const text = [result.final, ...result.replies].join('\n')
        // Facts only from the cluster_status API result (fake cluster: own release).
        expect(text).toContain('xv-main-0')
        expect(text).toMatch(/Knoten node-a/)
        expect(text).toMatch(/worker-general/)
        // No inventions, no foreign namespace, no SSH.
        expect(text).not.toMatch(/fantasy-pod|ghost-node|fremd/)
        expect(text).not.toMatch(/nicht konfiguriert/i)
        expect(result.executedTools).not.toContain('ssh_command')
        expect(result.executedTools).not.toContain('run_command')
        expect(result.executedTools).toContain('cluster_status')
    }, T)
})
