import { describe, expect, it } from 'vitest'
import { pendingScreenshot } from './screenshot-delivery.js'

describe('pipeline screenshot delivery', () => {
    it('does not resend a screenshot the tool already delivered', () => {
        expect(pendingScreenshot({ screenshotPath: '/v/desktop_1.png', screenshotDelivered: true })).toBeNull()
    })
    it('sends a screenshot of this run that was not delivered yet', () => {
        expect(pendingScreenshot({ screenshotPath: '/v/desktop_1.png', screenshotDelivered: false })).toBe('/v/desktop_1.png')
        expect(pendingScreenshot({ screenshotPath: '/v/desktop_1.png' })).toBe('/v/desktop_1.png')
    })
    it('sends nothing when the run produced no screenshot', () => {
        expect(pendingScreenshot({})).toBeNull()
        expect(pendingScreenshot(null)).toBeNull()
    })
})
