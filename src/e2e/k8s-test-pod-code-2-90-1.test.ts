/**
 * Abnahme 2.90.0, Langtest C (Telegram 29.10.2026 17:12): „Leg im k3s-Namespace xaventra-test einen
 * Test-Pod mit nginx an“ → cluster_test_pod verlangte die Freigabe (#99c5c5ff8a2f). Die nächste
 * Nachricht war nur „#99c5c5ff8a2f“: der Router bot 5 Werkzeuge an, cluster_test_pod nicht (es hängt
 * an einer Live-Route, die nur den aktuellen Satz liest) → nova_capabilities, load_skill_pack,
 * nova_introspect, run_command, „Die Aktion ist nicht gelungen“. Derselbe Weg gilt für die Antwort mit
 * dem echten Einmal-Code. Real entry (Telegram → Pipeline → Runner → Router → Werkzeug), scripted model,
 * Kubernetes-API als Fake auf loopback.
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

const PLAN = { aktion: 'anlegen', name: 'xvt-nginx', image: 'nginxinc/nginx-unprivileged:1.27-alpine', laufzeit_minuten: 60 }

describe('2.90.1 Test-Pod: der Zug nach der Freigabe-Aufforderung hat das Werkzeug', () => {
    it('Detail allein → ehrliche Anleitung; Einmal-Code → genau ein cluster_test_pod mit dem geplanten Pod', async () => {
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
        // Live this process is the Main and holds the lease (single node here, no coordinator under test).
        const fence = await h.module('mesh/fence.js')
        fence.adoptFence({ service: 'nova-main', epoch: 1, token: 'e2e', coordinator: 'local', nodeId: 'e2e-main', instanceId: 'e2e' })
        const { buildTestPod } = await h.module('infra/kubernetes-test-pods.js')
        const { approvalDetailOf } = await h.module('tools/owner-approval.js')
        const built = buildTestPod({ name: PLAN.name, image: PLAN.image, laufzeitSekunden: 3600 })
        expect(built.ok).toBe(true)
        const detail = approvalDetailOf(built.pod)

        // 1) Auftrag: das Werkzeug verlangt die Freigabe für genau diesen Pod.
        const ask = await h.telegram('Leg im k3s-Namespace xaventra-test einen Test-Pod mit nginx an, prüf ob er läuft', [
            { tools: [{ name: 'cluster_test_pod', arguments: PLAN }] },
            { text: `Dafür brauche ich deine Freigabe: /freigabe cluster_test_pod ${detail}` },
        ])
        expect(ask.error).toBeUndefined()
        expect(ask.offeredTools).toContain('cluster_test_pod')
        expect(ask.logs.join('\n')).toMatch(/cluster_test_pod braucht eine ausdrückliche Freigabe/)
        expect(fake.testPods.has('xvt-nginx')).toBe(false)

        // 2) Live-Fehler: der Owner schickt nur das Detail. Der Zug bietet cluster_test_pod an, und
        //    das Werkzeug sagt wieder ehrlich, was fehlt — keine Selbstauskunft, kein Pod.
        const hashOnly = await h.telegram(detail, [
            { tools: [{ name: 'cluster_test_pod', arguments: { ...PLAN, confirm: detail } }] },
            { text: 'Das ist nur das Detail — sende /freigabe cluster_test_pod mit diesem Detail und dann den Code.' },
        ])
        expect(hashOnly.error).toBeUndefined()
        expect(hashOnly.offeredTools).toContain('cluster_test_pod')
        expect(hashOnly.executedTools).not.toContain('nova_capabilities')
        expect(fake.testPods.has('xvt-nginx')).toBe(false)

        // 3) /freigabe → Einmal-Code.
        const approval = await h.telegram(`/freigabe cluster_test_pod ${detail}`)
        const code = approval.final.match(/nur für dich\):\s+(\S+)/)?.[1] || ''
        expect(code.length).toBeGreaterThan(10)

        // 4) Antwort mit dem Code: genau ein cluster_test_pod mit den geplanten Argumenten → Pod angelegt.
        const writesBefore = fake.writes().length
        const withCode = await h.telegram(`Freigabecode ${code}`, [
            { tools: [{ name: 'cluster_test_pod', arguments: { ...PLAN, confirm: code } }] },
            { text: 'Test-Pod xvt-nginx in xaventra-test angelegt.' },
        ])
        expect(withCode.error).toBeUndefined()
        expect(withCode.offeredTools).toContain('cluster_test_pod')
        expect(withCode.executedTools.filter(name => name === 'cluster_test_pod')).toHaveLength(1)
        const writes = fake.writes().slice(writesBefore)
        expect(writes).toHaveLength(1)
        expect(writes[0]).toMatchObject({ method: 'POST', path: `/api/v1/namespaces/${TEST_NS}/pods` })
        expect(fake.testPods.get('xvt-nginx')?.spec?.containers?.[0]?.image).toBe('nginxinc/nginx-unprivileged:1.27-alpine')
    }, T)
})
