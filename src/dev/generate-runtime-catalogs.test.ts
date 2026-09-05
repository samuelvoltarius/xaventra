import { describe, expect, it } from 'vitest'
import { catalogContentMatches } from './generate-runtime-catalogs.js'

describe('catalogContentMatches', () => {
    it('accepts equivalent LF and CRLF generated catalogs', () => {
        expect(catalogContentMatches('{\r\n  "version": 1\r\n}\r\n', '{\n  "version": 1\n}\n')).toBe(true)
    })

    it('still rejects semantic catalog changes', () => {
        expect(catalogContentMatches('{\r\n  "version": 1\r\n}\r\n', '{\n  "version": 2\n}\n')).toBe(false)
        expect(catalogContentMatches(undefined, '{}\n')).toBe(false)
    })
})
