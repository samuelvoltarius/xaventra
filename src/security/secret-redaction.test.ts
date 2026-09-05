import { describe, expect, it } from 'vitest'
import { redactSecrets } from './secret-redaction.js'

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
