import { describe, expect, it } from 'vitest'
import { forgetSecretValues, redactSecrets, registerSecretValue } from './secret-redaction.js'

describe('secret redaction', () => {
    it('redacts environment tokens in process listings', () => {
        // Assemble high-entropy fixtures at runtime so repository secret
        // scanners do not mistake test data for live credentials.
        const telegramToken = ['123456789:', 'abcdefghijklmnopqrstuvwxyzABCDEFGH'].join('')
        const minimaxKey = ['sk-', 'abcdefghijklmnopqrstuvwxyz123456'].join('')
        const output = redactSecrets(
            `docker --env TELEGRAM_BOT_TOKEN=${telegramToken} --env MINIMAX_API_KEY=${minimaxKey}`,
        )
        expect(output).not.toContain('abcdefghijklmnopqrstuvwxyz')
        expect(output).toContain('TELEGRAM_BOT_TOKEN=[REDACTED]')
        expect(output).toContain('MINIMAX_API_KEY=[REDACTED]')
    })

    it('redacts provider keys even when a user pasted them without a variable name', () => {
        const tavilyKey = ['tvly-dev-', 'AbCdEfGhIjKlMnOpQrStUvWxYz123456'].join('')
        const output = redactSecrets(`Mein Key ist ${tavilyKey}`)
        expect(output).toBe('Mein Key ist [REDACTED_API_KEY]')
    })
})

describe('secret redaction: sshpass and URL credentials (handover from layers review)', () => {
    it('redacts sshpass -p passwords', () => {
        const password = ['Pw', 'Geheim', '-2026!'].join('')
        for (const line of [`sshpass -p ${password} ssh pi@10.0.0.5`, `sshpass -p'${password}' ssh pi@10.0.0.5`, `sshpass -e -p "${password}" scp a b`]) {
            const output = redactSecrets(line)
            expect(output, line).not.toContain(password)
            expect(output).toContain('[REDACTED]')
        }
    })

    it('redacts the password part of URL userinfo but keeps user and host', () => {
        const password = ['s3cr', 'etPass'].join('')
        const output = redactSecrets(`git clone https://alfred:${password}@git.example.com/repo.git and postgres://nova:${password}@db:5432/x`)
        expect(output).not.toContain(password)
        expect(output).toContain('https://alfred:[REDACTED]@git.example.com/repo.git')
        expect(output).toContain('postgres://nova:[REDACTED]@db:5432/x')
    })
})

describe('2.88 live values from the password vault', () => {
    it('a value handed out by the broker is redacted everywhere redactSecrets runs, also without a key name', () => {
        // Assembled so secret scanners do not treat the fixture as a credential.
        const value = ['Sommer', 'Wiese', '42', 'x'].join('-')
        expect(redactSecrets(`Anmeldung mit ${value} fertig`)).toContain(value)
        registerSecretValue(value, 'github-main')
        expect(redactSecrets(`Anmeldung mit ${value} fertig`)).toBe('Anmeldung mit [TRESOR:github-main] fertig')
        expect(redactSecrets(JSON.stringify({ note: value }))).not.toContain(value)
        forgetSecretValues()
        expect(redactSecrets(value)).toBe(value)
    })
    it('ignores values too short to be safely matched and expires them', () => {
        registerSecretValue('abc', 'x')
        expect(redactSecrets('abc')).toBe('abc')
        const value = ['lange', 'genug', 'wert'].join('_')
        registerSecretValue(value, 'kurzlebig', { ttlMs: 1, now: 0 })
        expect(redactSecrets(value, { now: 10 })).toBe(value)
        forgetSecretValues()
    })
})
