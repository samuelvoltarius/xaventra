/** Pure pinned SDK request builders. Platform/network initialization belongs to
 * the actual controller, not read/invoke message construction. */
export async function matterRefreshRequest(): Promise<any> {
    const { Read } = await import('@matter/protocol')
    return Read({ attributes: [{}], fabricFilter: true })
}
export async function matterSwitchRequests(endpoint: number, on: boolean): Promise<{ invoke: any; read: any }> {
    if (!Number.isInteger(endpoint) || endpoint < 1 || endpoint > 65535 || typeof on !== 'boolean') throw new Error('Invalid Matter output')
    const [{ Invoke, Read }, { OnOff }, { EndpointNumber }] = await Promise.all([
        import('@matter/protocol'), import('@matter/types/clusters/on-off'), import('@matter/types'),
    ])
    const number = EndpointNumber(endpoint)
    return { invoke: Invoke({ commands: [{ endpoint: number, cluster: OnOff, command: on ? 'on' : 'off' }] }),
        read: Read({ fabricFilter: true }, { kind: 'attribute', endpoint: number, cluster: OnOff, attributes: ['onOff'] }) }
}
