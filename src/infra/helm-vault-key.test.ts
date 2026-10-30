import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HelmLite } from '../../test/helpers/helm-lite.js'

// 2.91.2: the vault key (2.91.1, one key for all sealed stores) can come from a Kubernetes Secret. With
// vaultKey.existingSecret the worker DaemonSets and an in-cluster Main mount it read-only where the daemon reads it
// (/run/secrets/xaventra-credential-key, docs/CONFIGURATION.md "Vault key" source 3); without it nothing is mounted.
const CHART = join(fileURLToPath(new URL('../..', import.meta.url)), 'deploy/helm/xaventra')
type Obj = Record<string, any>
const MAIN_ON = { main: { enabled: true }, config: { existingSecret: 'xv-config' } }
const PATH = '/run/secrets/xaventra-credential-key'

const pods = (objects: Obj[]) => objects.filter(o => ['StatefulSet', 'DaemonSet', 'Deployment'].includes(o.kind))
const mountOf = (pod: Obj) => pod.spec.template.spec.containers.flatMap((c: Obj) => c.volumeMounts || []).find((m: Obj) => m.mountPath === PATH)
const volumeOf = (pod: Obj, name: string) => (pod.spec.template.spec.volumes || []).find((v: Obj) => v.name === name)

// The repair sandbox snapshots no deploy/ files: the chart is only loaded where it exists (like helm-chart.test.ts).
const CHART_PRESENT = existsSync(join(CHART, 'Chart.yaml')) && existsSync(join(CHART, 'templates'))
const chart = (CHART_PRESENT ? new HelmLite(CHART) : null) as HelmLite

if (!CHART_PRESENT) it.skip('Helm-Chart fehlt in diesem Abbild (Reparatur-Sandbox)', () => {})
else describe('Helm: vault key from a Secret', () => {

    it('with vaultKey.existingSecret every worker and the Main mount the key read-only (0400, group of the container user)', () => {
        const objects = chart.objects({ values: { ...MAIN_ON, vaultKey: { existingSecret: 'xv-vault-key' } } })
        expect(pods(objects).length).toBeGreaterThan(1)
        for (const pod of pods(objects)) {
            const mount = mountOf(pod)
            expect(mount, pod.metadata.name).toMatchObject({ readOnly: true, subPath: 'credential.key' })
            const volume = volumeOf(pod, mount.name)
            expect(volume.secret).toMatchObject({ secretName: 'xv-vault-key', defaultMode: 256, items: [{ key: 'credential.key', path: 'credential.key' }] })
            expect(pod.spec.template.spec.securityContext).toMatchObject({ runAsUser: 1000, fsGroup: 1000 })
        }
    })

    it('a custom key name is used', () => {
        const objects = chart.objects({ values: { vaultKey: { existingSecret: 'xv-vault-key', key: 'key.bin' } } })
        for (const pod of pods(objects)) expect(mountOf(pod)?.subPath).toBe('key.bin')
    })

    it('without the value nothing is mounted', () => {
        for (const pod of pods(chart.objects({ values: MAIN_ON }))) expect(mountOf(pod), pod.metadata.name).toBeUndefined()
    })
})
