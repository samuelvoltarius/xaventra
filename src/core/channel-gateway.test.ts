import { describe, expect, it } from 'vitest'
import { ChannelGateway } from './channel-gateway.js'

describe('channel gateway lifecycle', () => {
    it('starts with one canonical status map', () => {
        expect(new ChannelGateway().getStatus()).toEqual({
            telegram: 'stopped', whatsapp: 'stopped', discord: 'stopped', dashboard: 'stopped',
        })
    })
})
