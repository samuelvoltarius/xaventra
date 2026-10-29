/**
 * 2.90.3 (Abnahme 2.90.2, Langtest C, VM 130 29.10. 23:27:52-23:28:07): after the one-time code cluster_test_pod
 * created xvt-probe (23:27:52), listed (54), read logs (56) and deleted it (23:28:01) - the goal was reached. A 5th,
 * superfluous call failed ("Kommando: ungültiger Eintrag. Nichts angelegt") and the owner got
 * "❌ Abgebrochen · 24 s — Die Aktion ist nicht gelungen … es wurde keine Änderung ausgeführt." - twice.
 * A last superfluous failed step never overrides proven changes of the same run; "keine Änderung" is never
 * said when a change is proven; the answer is delivered once. A real failure without success stays ❌.
 */
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createE2EHarness, type E2EHarness } from '../../test/helpers/e2e-harness.js'
import { NS, TEST_NS, controlPolicyRaw, createFakeKube } from '../../test/helpers/fake-kube.js'
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
const T = 120_000

async function startFakeKube() {
    const fake = createFakeKube()
    const { cert, key } = selfSignedCert('localhost')
    kubeServer = createServer({ cert, key }, (req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', async () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            let body: unknown
            if (raw) { try { body = JSON.parse(raw) } catch { body = undefined } }
            const response = await fake.transport({ method: (req.method || 'GET') as any, path: req.url || '/', body, contentType: req.headers['content-type'] as any })
            res.writeHead(response.status, { 'content-type': 'application/json' })
            res.end(JSON.stringify(response.data ?? null))
        })
    })
    await new Promise<void>(resolve => kubeServer!.listen(0, '127.0.0.1', () => resolve()))
    return { port: (kubeServer.address() as AddressInfo).port, cert, fake }
}

const PROBE = { aktion: 'anlegen', name: 'xvt-probe', image: 'docker.io/library/busybox:1.36', laufzeit_minuten: 10 }

async function harness() {
    const { port, cert, fake } = await startFakeKube()
    h = await createE2EHarness({
        seed: root => {
            writeFileSync(join(root, 'ca.crt'), cert)
            writeFileSync(join(root, 'k8s-token'), 'e2e-not-a-real-token')
            writeFileSync(join(root, 'control.json'), JSON.stringify(controlPolicyRaw()))
            const cfg = JSON.parse(readFileSync(join(root, 'xaventra.config.json'), 'utf8'))
            cfg.infra = { kubernetes: { server: `https://localhost:${port}`, caFile: join(root, 'ca.crt'), namespace: NS, release: 'xv', controlFile: join(root, 'control.json') } }
            writeFileSync(join(root, 'xaventra.config.json'), JSON.stringify(cfg, null, 2))
            process.env.XAVENTRA_K8S_TOKEN_FILE = join(root, 'k8s-token')
        },
    })
    const fence = await h.module('mesh/fence.js')
    fence.adoptFence({ service: 'nova-main', epoch: 1, token: 'e2e', coordinator: 'local', nodeId: 'e2e-main', instanceId: 'e2e' })
    const { buildTestPod } = await h.module('infra/kubernetes-test-pods.js')
    const { approvalDetailOf } = await h.module('tools/owner-approval.js')
    const built = buildTestPod({ name: PROBE.name, image: PROBE.image, laufzeitSekunden: 600 })
    const detail = approvalDetailOf(built.pod)
    const approval = await h.telegram(`/freigabe cluster_test_pod ${detail}`)
    const code = approval.final.match(/nur für dich\):\s+(\S+)/)?.[1] || ''
    expect(code.length).toBeGreaterThan(10)
    return { fake, code }
}

/** Same wiring as daemon-channels startTelegram: progress into the live card, then the answer. Returns every
 * text the chat shows at the end (sent messages + the card's last state unless it was deleted). */
async function deliverOverStatusCard(answer: string): Promise<string[]> {
    const { TelegramPresentationSession } = await import('../channels/telegram-presentation.js')
    const sent: string[] = []
    let card: string | null = null
    const adapter = {
        send: async (msg: any) => { sent.push(String(msg?.content ?? '')) },
        sendProgress: async (_chatId: string, text: string) => { card = String(text); return 42 },
        editMessage: async (_chatId: string, _id: number, text: string) => { card = String(text) },
        deleteMessage: async () => { card = null },
    }
    const session = new TelegramPresentationSession(adapter as any, '1000000001', { statusCard: true, minEditIntervalMs: 0 })
    await session.deliver('⚙️ Schritt 1/5: cluster_test_pod')
    await session.deliver(answer)
    await session.clearProgress()
    return card === null ? sent : [card, ...sent]
}

describe('2.90.3 a superfluous failed last step never hides proven changes', () => {
    it('the answer with proven changes closes the card without a second copy', async () => {
        const chat = await deliverOverStatusCard('Erledigt: Test-Pod xvt-probe in xaventra-test angelegt (Phase Pending); Test-Pod xvt-probe in xaventra-test gelöscht.\n\nEin späterer Schritt ist danach nicht gelungen; die Ursache ist intern zur Prüfung vorgemerkt.')
        expect(chat.filter(text => text.includes('Erledigt: Test-Pod'))).toHaveLength(1)
        expect(chat.some(text => /Abgebrochen/.test(text))).toBe(false)
    })

    it('create, list, logs, delete, then an invalid 5th call: the answer names the done steps, once, without "keine Änderung"', async () => {
        const { fake, code } = await harness()
        const result = await h!.telegram(`Freigabecode ${code} — leg den Test-Pod an, prüf ihn und lösch ihn danach wieder`, [
            { tools: [{ name: 'cluster_test_pod', arguments: { ...PROBE, confirm: code } }] },
            { tools: [{ name: 'cluster_test_pod', arguments: { aktion: 'liste' } }] },
            { tools: [{ name: 'cluster_test_pod', arguments: { aktion: 'logs', name: 'xvt-probe' } }] },
            { tools: [{ name: 'cluster_test_pod', arguments: { aktion: 'loeschen', name: 'xvt-probe' } }] },
            { tools: [{ name: 'cluster_test_pod', arguments: { ...PROBE, kommando: '["sh","-c","echo \u0007"]' } }] },
            // Live: no model answer after the 5th call (the run ended over the failure escalation).
            () => { throw new Error('TimeoutError: model request timed out') },
        ])
        expect(result.error).toBeUndefined()
        expect(fake.testPods.has('xvt-probe')).toBe(false)
        expect(result.final).not.toMatch(/keine Änderung|nichts verändert|^❌|^Die Aktion ist nicht gelungen/)
        expect(result.final).toMatch(/^Erledigt: .*xvt-probe.*angelegt.*gelöscht/s)
        expect(result.replies).toHaveLength(1)
    }, T)

    it('a real failure without any success stays a failure', async () => {
        const { fake } = await harness()
        const result = await h!.telegram('Leg einen Test-Pod mit kaputtem Kommando an', [
            { tools: [{ name: 'cluster_test_pod', arguments: { ...PROBE, kommando: '["sh","-c","echo \u0007"]' } }] },
            () => { throw new Error('TimeoutError: model request timed out') },
        ])
        expect(result.error).toBeUndefined()
        expect(fake.testPods.has('xvt-probe')).toBe(false)
        expect(result.final).toMatch(/Die Aktion ist nicht gelungen|nicht hinbekommen/)
        expect(result.final).not.toMatch(/Erledigt/)
        const { isTelegramFailureReply } = await h!.module('channels/telegram-presentation.js')
        expect(isTelegramFailureReply(result.final)).toBe(true)
        // Live the failure text stood twice: the card closed as "❌ Abgebrochen · 24 s" + the answer, and the answer.
        const chat = await deliverOverStatusCard(result.final)
        expect(chat.filter(text => text.includes(result.final.slice(0, 40)))).toHaveLength(1)
        expect(chat.some(text => /^❌ Abgebrochen · \d+ s$/.test(text))).toBe(true)
    }, T)
})
