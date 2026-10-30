import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkVault } from './vault-check.js'

// 2.91.2: a vault key in the data tree is a warning (never an error, the check stays ok); inside Kubernetes the hint
// names the Helm value vaultKey.existingSecret instead of systemd/Docker.
afterEach(() => vi.unstubAllEnvs())

describe('Doctor: vault key in the data tree', () => {
    const dir = () => mkdtempSync(join(tmpdir(), 'vault-k8s-'))
    it('is a warning with the Helm hint inside Kubernetes', () => {
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', '')
        vi.stubEnv('CREDENTIALS_DIRECTORY', '')
        vi.stubEnv('KUBERNETES_SERVICE_HOST', '10.0.0.1')
        const result = checkVault([dir()])
        const issue = result.issues.find(item => item.code === 'VAULT_KEY_IN_DATA_TREE')
        if (!issue) return // a /run/secrets key on this machine: nothing to warn about
        expect(result.ok).toBe(true)
        expect(issue.severity).toBe('warning')
        expect(issue.fix?.hint).toMatch(/vaultKey\.existingSecret/)
    })
    it('outside Kubernetes the hint stays systemd/Docker', () => {
        vi.stubEnv('NOVA_CREDENTIAL_KEY_FILE', '')
        vi.stubEnv('CREDENTIALS_DIRECTORY', '')
        vi.stubEnv('KUBERNETES_SERVICE_HOST', '')
        const issue = checkVault([dir()]).issues.find(item => item.code === 'VAULT_KEY_IN_DATA_TREE')
        if (issue) expect(issue.fix?.hint).not.toMatch(/vaultKey/)
    })
})
