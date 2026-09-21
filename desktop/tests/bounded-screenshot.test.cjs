const assert = require('node:assert/strict')
const { test } = require('node:test')

const load = () => import('../../scripts/lib/bounded-screenshot.mjs')

test('evidence screenshot uses its own bounded deadline and records one attempt', async () => {
  const { captureEvidenceScreenshot } = await load()
  const calls = []
  const result = await captureEvidenceScreenshot({
    screenshot: async options => { calls.push(options) },
  }, { path: 'fixture.jpg', timeoutMs: 23000 })
  assert.deepEqual(result, { attempts: 1, timeoutMs: 23000 })
  assert.equal(calls[0].timeout, 23000)
  assert.equal(calls[0].animations, 'disabled')
})

test('evidence screenshot retries one transient compositor stall', async () => {
  const { captureEvidenceScreenshot } = await load()
  let attempts = 0
  const result = await captureEvidenceScreenshot({
    screenshot: async () => {
      attempts++
      if (attempts === 1) throw new Error('transient screenshot timeout')
    },
    waitForTimeout: async () => {},
  }, { path: 'fixture.jpg', timeoutMs: 20000 })
  assert.equal(attempts, 2)
  assert.equal(result.attempts, 2)
})

test('evidence screenshot preserves a repeated failure as terminal', async () => {
  const { captureEvidenceScreenshot } = await load()
  let attempts = 0
  await assert.rejects(() => captureEvidenceScreenshot({
    screenshot: async () => { attempts++; throw new Error(`failure-${attempts}`) },
    waitForTimeout: async () => {},
  }, { path: 'fixture.jpg', timeoutMs: 20000 }), /failure-2/)
  assert.equal(attempts, 2)
})
