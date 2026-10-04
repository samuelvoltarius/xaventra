import { it, expect } from 'vitest'
import { matterRefreshRequest, matterSwitchRequests } from './matter-wire.js'
it('builds real pinned SDK wildcard read and argument-free exact OnOff invoke/readback paths', async () => {
    expect(await matterRefreshRequest()).toMatchObject({ attributeRequests: [{}], isFabricFiltered: true })
    for (const on of [true, false]) {
        const request = await matterSwitchRequests(7, on)
        expect(request.invoke.invokeRequests).toHaveLength(1)
        expect(request.invoke.invokeRequests[0].commandPath).toEqual({ endpointId: 7, clusterId: 6, commandId: on ? 1 : 0 })
        expect(request.read.attributeRequests).toEqual([{ endpointId: 7, clusterId: 6, attributeId: 0 }])
    }
    await expect(matterSwitchRequests(0, true)).rejects.toThrow()
}, 20_000) // Real SDK cold import is expensive under the full parallel suite.
