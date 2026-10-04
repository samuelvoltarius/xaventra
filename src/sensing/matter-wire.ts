/** Real pinned SDK request builders; imported only by isolated Matter operations. */
export async function matterRefreshRequest(): Promise<any> {
    const { Read } = await import('@matter/main/protocol')
    return Read({ attributes: [{}], fabricFilter: true })
}
export async function matterSwitchRequests(endpoint: number, on: boolean): Promise<{ invoke: any; read: any }> {
    if (!Number.isInteger(endpoint) || endpoint < 1 || endpoint > 65535 || typeof on !== 'boolean') throw new Error('Invalid Matter output')
    const { Invoke, Read } = await import('@matter/main/protocol')
    const { OnOff } = await import('@matter/main/clusters/on-off')
    const { EndpointNumber } = await import('@matter/main/types')
    const number = EndpointNumber(endpoint)
    return { invoke: Invoke({ commands: [{ endpoint: number, cluster: OnOff, command: on ? 'on' : 'off' }] }),
        read: Read({ fabricFilter: true }, { kind: 'attribute', endpoint: number, cluster: OnOff, attributes: ['onOff'] }) }
}
