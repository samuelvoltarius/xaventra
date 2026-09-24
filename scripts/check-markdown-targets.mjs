// Real loopback HTTP; controlled search fixture, not live SearXNG/Telegram.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { inferRequiredToolTargets, matchedToolTargets } from '../dist/core/tool-evidence-binding.js'

const observed = []
const server = createServer((request, response) => {
  observed.push(request.url)
  response.setHeader('Content-Type', 'application/json')
  response.end(JSON.stringify({ results: [{ title: 'Controlled Agent result' }] }))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
try {
  const base = `http://127.0.0.1:${server.address().port}`
  const goal = `test es noch mal [24.09.2026 15:56] Person: Backend: search
URL: [${base}](${base})
[24.09.2026 18:27] Person: check mal url --get '[${base}/search](${base}/search)' --data-urlencode 'q=Agent' --data-urlencode 'format=json'
[24.09.2026 18:28] Assistant: Previous attempt failed.`
  const required = inferRequiredToolTargets(goal)
  const url = `${base}/search?q=Agent&format=json`
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  assert.equal(response.status, 200)
  assert.equal((await response.json()).results[0].title, 'Controlled Agent result')
  assert.deepEqual(observed, ['/search?q=Agent&format=json'])
  assert.deepEqual(matchedToolTargets(required, { url }), required)
  assert.equal(required.length, 1)
  for (const wrong of [base, `${base}/search`, `${base}/search?q=Other&format=json`]) {
    assert.deepEqual(matchedToolTargets(required, { url: wrong }), [])
  }
  console.log(JSON.stringify({ success: true, scope: 'controlled loopback HTTP, not live search or Telegram', requests: observed.length, required }))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
