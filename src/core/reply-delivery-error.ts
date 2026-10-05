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
        catch (error) { throw error instanceof ReplyDeliveryError ? error : new ReplyDeliveryError(error) }
    }
}
