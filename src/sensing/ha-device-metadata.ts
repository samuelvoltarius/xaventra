/** Fixed read-only HA registry projection. No arbitrary template, secret field,
 * action or service call is accepted from devices or a model. */
import { cleanText } from './ports.js'
import { redactSecrets } from '../security/secret-redaction.js'
import type { HaFunction } from './ha-inventory.js'

export function haDeviceTemplate(functions: HaFunction[]): string {
    const ids = [...new Set(functions.map(f => f.id).filter(id => /^[a-z_]+\.[a-z0-9_]{1,120}$/.test(id)))].slice(0, 200)
    return `{% set ids = ${JSON.stringify(ids)} %}[{% for e in ids %}{{ {'entity_id': e, 'device_id': device_id(e), 'manufacturer': device_attr(e, 'manufacturer'), 'model': device_attr(e, 'model')} | tojson }}{% if not loop.last %},{% endif %}{% endfor %}]`
}

export function applyHaDeviceMetadata(functions: HaFunction[], body: unknown): HaFunction[] {
    if (!Array.isArray(body) || body.length > 200) throw new Error('Invalid HA metadata')
    const field = (v: unknown) => typeof v === 'string' && v.length <= 160 && !/^(unknown|none|null)$/i.test(v.trim())
        ? cleanText(redactSecrets(v), 80) : ''
    return functions.map(f => {
        const matches = body.filter(row => row && row.entity_id === f.id)
        if (matches.length !== 1) return f
        const row = matches[0]
        // HA's device registry represents physical devices AND logical services.
        // Do not turn registry membership into an authenticated physical proof.
        if (typeof row.device_id !== 'string' || !/^[a-f0-9]{32}$/i.test(row.device_id)) return f
        const manufacturer = field(row.manufacturer), model = field(row.model)
        return { ...f, deviceId: row.device_id.toLowerCase(), identitySource: 'home-assistant-device-registry',
            ...(manufacturer ? { manufacturer } : {}), ...(model ? { model } : {}) }
    })
}

export async function boundedHaJson(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error('HA read not available')
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing HA body')
    const chunks: Uint8Array[] = []; let size = 0
    try {
        for (;;) { const next = await reader.read(); if (next.done) break
            size += next.value.length; if (size > 512_000) throw new Error('HA read too large')
            chunks.push(next.value)
        }
    } finally { await reader.cancel().catch(() => undefined) }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
