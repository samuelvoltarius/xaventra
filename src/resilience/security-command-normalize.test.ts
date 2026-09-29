import { describe, expect, it } from 'vitest'
import { getSecurity } from './security.js'

// MI-20: the command denylist matched raw substrings; spacing, split flags or
// quotes bypassed it. Still only a denylist, but no longer trivially bypassed.

describe('MI-20 command denylist normalization', () => {
    it.each([
        'rm -rf /',
        'rm -r -f /',
        'rm  -rf  /',
        'rm --recursive --force /*',
        'rm -fr /',
        'echo hi; rm -r -f -- /',
        "r'm' -rf /",
        'mkfs  .ext4 /dev/sda',
        'xm"r"ig --donate-level 1',
    ])('blocks %s', command => {
        expect(getSecurity().checkCommand(command, true).allowed).toBe(false)
    })

    it.each(['rm -rf ./build', 'rm -r /tmp/nova-test', 'ls -la /'])('still allows %s', command => {
        expect(getSecurity().checkCommand(command, true).allowed).toBe(true)
    })
})
