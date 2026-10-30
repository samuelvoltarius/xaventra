import { redactSecrets } from '../security/secret-redaction.js'

/** Delivery failures must leave the channel failed, never restart inference. */
export class ReplyDeliveryError extends Error {
    constructor(cause: unknown) {
        super('Reply delivery failed', { cause })
        this.name = 'ReplyDeliveryError'
    }
}

export function protectReplyDelivery(reply: (message: string) => Promise<void>) {
    return async (message: string): Promise<void> => {
        try { await reply(message) }
        catch (error) {
            if (error instanceof ReplyDeliveryError) throw error
            const failure = new ReplyDeliveryError(error)
            // 2.92.0: a lost reply is a Doctor finding (one per signature), not only a log line.
            const line = deliveryFailureText(failure)
            void import('./self-doctor.js')
                .then(({ recordErrorFinding }) => recordErrorFinding({ source: 'reply-delivery', key: line, line, title: 'Antwort nicht zugestellt' }))
                .catch(() => undefined)
            throw failure
        }
    }
}

/** 2.89.13: log line for a failed turn; a delivery failure keeps its transport cause (redacted, bounded). */
export function deliveryFailureText(error: unknown): string {
    const base = String(error)
    if (!(error instanceof ReplyDeliveryError) || error.cause === undefined) return base
    const cause = redactSecrets(String(error.cause)).replace(/\s+/g, ' ').slice(0, 200)
    return `${base} (Ursache: ${cause})`
}
