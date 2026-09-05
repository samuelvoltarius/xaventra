#!/usr/bin/env bash
set -euo pipefail

docker exec nova-spark node --input-type=module -e "
const response = await fetch('http://100.64.0.10:18789/v1/message', {
  method: 'POST',
  headers: {
    authorization: 'Bearer ' + process.env.NOVA_API_TOKEN,
    'content-type': 'application/json'
  },
  body: JSON.stringify({
    content: 'Antworte exakt mit NOVA_SPARK_OK',
    from: 'spark-smoke',
    channel: 'rest-api'
  })
})
const body = await response.text()
console.log(body)
if (!response.ok) process.exit(1)
"
