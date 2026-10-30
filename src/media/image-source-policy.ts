/**
 * Which local images may leave for evaluation (30.10.2026, Abschnitt 5 Selbst-Anbindung).
 * Alfred released images to MiniMax; the fixed limits live here, in one place:
 *   - only files in the private image folders under `.nova-vision`, never a free path
 *   - node captures only from released nodes (default the lab; XAVENTRA_VISION_NODES)
 *   - camera stills in `kamera/`
 *   - images of the car (`auto/`) stay refused until the Panoptes rules allow them
 *   - local desktop screenshots stay refused (Alfred's PC block, until he lifts it)
 * Bytes never go to logs, audit, model text or memory.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { getRuntimeRoot } from '../core/data-root.js'

export type ImageSource = 'lab' | 'kamera'
export interface SendableImage { base64: string; mime: 'image/png' | 'image/jpeg'; source: ImageSource }

const MAX_BYTES = 8 * 1024 * 1024
const PNG = Buffer.from('89504e470d0a1a0a', 'hex')
const JPEG = Buffer.from('ffd8ff', 'hex')
const visionRoot = () => join(getRuntimeRoot(), '.nova-vision')
const refused = (what: string) => new Error(`Bildquelle nicht freigegeben: ${what}. Es wurde nichts gesendet.`)
const inside = (parent: string, child: string) => { const rel = relative(parent, child); return Boolean(rel) && !rel.startsWith('..') && !rel.startsWith(sep) }

const allowedNodes = (): string[] => String(process.env.XAVENTRA_VISION_NODES || 'xaventra-lab').split(',').map(item => item.trim()).filter(Boolean)

/** A file under the private image root: it is evaluated only through assertSendableImage, never another way. */
export function isPrivateImagePath(path: string): boolean {
    return inside(visionRoot(), resolve(path))
}

function sourceOf(path: string): ImageSource {
    const root = visionRoot(), full = resolve(path)
    if (!inside(root, full)) throw refused('kein privater Bildordner')
    const folder = relative(root, dirname(full))
    if (folder === 'kamera') return 'kamera'
    if (folder === 'mesh-captures') {
        const node = /^node_([a-z0-9._-]+)__\d+_[a-f0-9]+\.png$/i.exec(basename(full))?.[1]
        if (node && allowedNodes().includes(node)) return 'lab'
        throw refused(node ? `Aufnahme von ${node}` : 'Aufnahme ohne Knotenangabe')
    }
    if (folder === 'auto') throw refused('Bild vom Auto (nur nach den Panoptes-Regeln)')
    throw refused('lokale Desktop-Aufnahme')
}

/** The only way a local image gets ready to leave. Throws with a clear reason; nothing is sent then. */
export function assertSendableImage(path: string): SendableImage {
    const source = sourceOf(path)
    const full = resolve(path)
    let bytes: Buffer
    try {
        const stat = lstatSync(full)
        if (!stat.isFile() || stat.isSymbolicLink()) throw refused('kein normales Bild')
        if (realpathSync(full) !== realpathSync(dirname(full)) + sep + basename(full)) throw refused('Verknüpfung')
        if (stat.size > MAX_BYTES) throw new Error('Bild zu groß (höchstens 8 MB). Es wurde nichts gesendet.')
        bytes = readFileSync(full)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code) throw new Error('Bilddatei nicht lesbar. Es wurde nichts gesendet.')
        throw error
    }
    const mime = bytes.subarray(0, 8).equals(PNG) ? 'image/png' as const : bytes.subarray(0, 3).equals(JPEG) ? 'image/jpeg' as const : null
    if (!mime) throw new Error('Nur PNG oder JPEG. Es wurde nichts gesendet.')
    return { base64: bytes.toString('base64'), mime, source }
}
