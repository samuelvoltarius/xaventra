import { it, expect } from 'vitest'
import { matterRefreshRequest, matterSwitchRequests } from './matter-wire.js'

// The first load of the SDK (about 6200 files) took 10 to 18 s with cold files
// and 1.3 s afterwards, on an idle machine: a child process with a 15 s limit
// failed on the file cache, not on the code. The real SDK loads natively here
// (Vitest externalizes node_modules, nothing below is mocked), so one generous
// bound for the slow first load replaces the child process.
const COLD_SDK_LOAD_MS = 120_000

it('builds real pinned SDK wildcard read and argument-free exact OnOff invoke/readback paths', async () => {
    const refresh = await matterRefreshRequest()
    const switches = await Promise.all([true, false].map(on => matterSwitchRequests(7, on)))
    await expect(matterSwitchRequests(0, true)).rejects.toThrow('Invalid Matter output')
    // The requests as they leave for the wire: plain JSON, no SDK objects.
    const result = JSON.parse(JSON.stringify({ refresh, switches }))
    expect(result.refresh).toMatchObject({ attributeRequests: [{}], isFabricFiltered: true })
    for (const [index, on] of [true, false].entries()) {
        const request = result.switches[index]
        expect(request.invoke.invokeRequests).toHaveLength(1)
        expect(request.invoke.invokeRequests[0].commandPath).toEqual({ endpointId: 7, clusterId: 6, commandId: on ? 1 : 0 })
        expect(request.read.attributeRequests).toEqual([{ endpointId: 7, clusterId: 6, attributeId: 0 }])
    }
}, COLD_SDK_LOAD_MS)
