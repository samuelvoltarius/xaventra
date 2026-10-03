import { existsSync } from 'node:fs'

/** Read-only CLI discovery shared by host inspection and sensing. */
export function tailscaleStatusCommand(binary: string, exists = existsSync) {
    if (binary === '/snap/bin/tailscale' && exists('/snap/tailscale/current/bin/tailscale')
        && exists('/var/snap/tailscale/common/socket/tailscaled.sock')) {
        return { binary: '/snap/tailscale/current/bin/tailscale', args: ['--socket=/var/snap/tailscale/common/socket/tailscaled.sock', 'status', '--json'] }
    }
    return { binary, args: ['status', '--json'] }
}
