import { describe, expect, it } from 'vitest'
import { redactSecrets } from './secret-redaction.js'

// H6 regression: JSON key/value secrets and PEM private key blocks.
// Fixtures are assembled at runtime so secret scanners ignore them.
const secret = ['s3cr3t', 'Value', '42xyz'].join('')

describe('secret redaction of structured content (H6)', () => {
    it.each(['token', 'password', 'apiKey', 'api_key', 'secret', 'authorization', 'accessToken', 'client_secret', 'botToken', 'Authorization'])('redacts JSON "%s" values', key => {
        const output = redactSecrets(JSON.stringify({ user: 'sample', [key]: secret }, null, 2))
        expect(output).not.toContain(secret)
        expect(output).toContain(`"${key}": "[REDACTED]"`)
        expect(output).toContain('"user": "sample"')
    })

    it('redacts compact and escaped JSON', () => {
        expect(redactSecrets(`{"password":"${secret}","n":1}`)).toBe('{"password":"[REDACTED]","n":1}')
        const escaped = redactSecrets(`log: "{\\"token\\": \\"${secret}\\"}"`)
        expect(escaped).not.toContain(secret)
    })

    it('redacts values containing escaped quotes completely', () => {
        const output = redactSecrets(`{"secret": "ab\\"${secret}"}`)
        expect(output).not.toContain(secret)
    })

    it('keeps non-secret numeric fields such as maxTokens', () => {
        expect(redactSecrets('{"maxTokens": 1000}')).toBe('{"maxTokens": 1000}')
    })

    it('redacts PEM private key blocks, also when truncated', () => {
        const body = ['MIIEvQIBADANBgkqhkiG9w0BAQEFAASC', 'BKcwggSjAgEAAoIBAQC7'].join('\n')
        for (const kind of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'OPENSSH PRIVATE KEY', 'EC PRIVATE KEY', 'ENCRYPTED PRIVATE KEY']) {
            const pem = `before\n-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----\nafter`
            const output = redactSecrets(pem)
            expect(output).not.toContain('MIIEvQ')
            expect(output).toContain('before')
            expect(output).toContain('after')
            const truncated = redactSecrets(`x\n-----BEGIN ${kind}-----\n${body}`)
            expect(truncated).not.toContain('MIIEvQ')
        }
    })

    it('leaves public certificates alone', () => {
        const cert = '-----BEGIN CERTIFICATE-----\nMIIBpublic\n-----END CERTIFICATE-----'
        expect(redactSecrets(cert)).toBe(cert)
    })
})
