/**
 * Mesh node self-update (H-3).
 *
 * The update task is a command line the target node runs. Nothing from the
 * HTTP request may reach it: the bundle URL comes only from configuration
 * (NOVA_MESH_BUNDLE_URL or dashboard.bundleUrl) and must be a plain http(s)
 * URL without credentials, query, fragment or characters a shell interprets.
 */

const SAFE_URL_BODY = /^[A-Za-z0-9.:[\]/_-]+$/

export function resolveMeshBundleUrl(config: any, env: NodeJS.ProcessEnv = process.env): string | null {
    const raw = String(env.NOVA_MESH_BUNDLE_URL || config?.dashboard?.bundleUrl || '').trim()
    if (!raw) return null
    let url: URL
    try { url = new URL(raw) } catch { return null }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.username || url.password || url.search || url.hash) return null
    const body = url.href.slice(url.protocol.length + 2)
    if (!SAFE_URL_BODY.test(body)) return null
    return url.href
}

export function buildNodeUpdateCommand(bundleUrl: string): string {
    const url = resolveMeshBundleUrl({}, { NOVA_MESH_BUNDLE_URL: bundleUrl })
    if (!url || url !== bundleUrl) throw new Error('Unsafe mesh bundle URL')
    return `cd ~/nova-core && curl -sfL '${url}' -o /tmp/nova-bundle.tar.gz && tar xzf /tmp/nova-bundle.tar.gz --overwrite && rm /tmp/nova-bundle.tar.gz && echo "UPDATE_OK: $(date)" && (killall -q node; sleep 2; cd ~/nova-core && nohup node dist/daemon.js > nova.log 2>&1 &)`
}
