import type { Express, Request, Response } from 'express'
import { loadDevices, sensingDeviceFingerprint, type Approver } from './device-registry.js'
import { approvedSmartRoute } from './smart-device-route.js'
import { getTuyaLocalAccess, submitTuyaLocalAccess, getEspHomeAccess, submitEspHomeAccess, getTuyaCloudAccess, getShellyCloudAccess, submitSmartCloudAccess, getMatterAccess, submitMatterAccess, beginMatterAttempt, finishMatterAttempt, matterFabricPath } from './smart-device-access.js'
import { readMatterPeer } from './matter-client.js'
import { accessStored, connectionState, standKontext } from '../connections/connection-state.js'
import { currentSmartFunctions, switchSupported, proposeSmartSwitch, confirmSmartSwitch } from './smart-control.js'
import { executeSmartSwitch } from './smart-control-http.js'

/** Access input is never a chat tool. Owner-authenticated and Main-fenced only. */
export function registerSmartAccessApi(app: Express, options: {
    ownerOnly: (req: Request, res: Response) => boolean; authoritative: () => boolean;
    root: () => string; owner: (req: Request) => Promise<Approver>;
    matterRead?: typeof readMatterPeer;
    controlExecute?: typeof executeSmartSwitch;
}): void {
    app.get('/api/desktop/smart-geraete', async (req, res) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        const root = options.root()
        const all = loadDevices(root)
        // 2.89: the one connection truth — the same state as the device list and „Verbindungen“.
        const kontext = standKontext(root, { devices: all })
        res.json({ devices: all.filter(d => ['tuya-announcements', 'esphome-native', 'shelly-readonly', 'matter-ip', 'hue-readonly', 'tasmota-readonly'].includes(d.hardware?.connector)).map(d => ({
            id: d.id, name: d.name, fingerprint: sensingDeviceFingerprint(d), route: approvedSmartRoute(root, d),
            protocol: d.hardware?.connector === 'matter-ip' ? 'matter' : d.hardware?.connector === 'esphome-native' ? 'esphome' : d.hardware?.connector === 'shelly-readonly' ? 'shelly' : d.hardware?.connector === 'hue-readonly' ? 'hue' : d.hardware?.connector === 'tasmota-readonly' ? 'tasmota' : 'tuya',
            // Hue pairing key included; Matter counts only once its access is connected.
            accessStored: accessStored(root, d),
            ...(({ zustand, grund }) => ({ zustand, grund, verbunden: zustand === 'verbunden' }))(connectionState(root, { record: d }, kontext)),
            ...(d.hardware?.connector === 'matter-ip' ? { accessState: getMatterAccess(root, d)?.state || 'missing' } : {}),
            controls: currentSmartFunctions(root, d).filter(f => switchSupported(d, f, approvedSmartRoute(root, d) || '')).map(f => ({ id: f.id, name: f.name, kind: f.kind })),
            // Not raw private access. Only the schema needed for an owner form.
            fields: approvedSmartRoute(root, d) === 'cloud'
                ? d.hardware?.connector === 'shelly-readonly'
                    ? [{ name: 'host', secret: false, label: 'Shelly-Cloud-Hostname aus der App (ohne https://)' }, { name: 'key', secret: true, label: 'Shelly-Cloud Auth-Key' }]
                    : d.hardware?.connector === 'tuya-announcements'
                        ? [{ name: 'client', secret: true, label: 'Tuya Access-ID' }, { name: 'secret', secret: true, label: 'Tuya Access-Secret' }, { name: 'region', label: 'Tuya-Region', choices: ['eu', 'us', 'cn', 'in'] }] : []
                : d.hardware?.connector === 'matter-ip' ? getMatterAccess(root, d) ? [] : [{ name: 'pairingCode', secret: true, label: 'Privater manueller Matter-Pairing-Code (11 oder 21 Ziffern)' }, { name: 'confirmPairing', label: 'Einmaliges Pairing durchführen, bestehende Fabrics erhalten', choices: ['ja'] }]
                    : d.hardware?.connector === 'esphome-native' ? [{ name: 'psk', secret: true, label: 'ESPHome API Encryption-Key', length: 44 }] : d.hardware?.connector === 'tuya-announcements' ? [{ name: 'key', secret: true, label: 'Tuya Local-Key', length: 16 }, { name: 'version', label: 'Tuya-Protokoll', choices: ['3.1', '3.3', '3.4', '3.5'] }] : [],
        })) })
    })
    app.post('/api/desktop/smart-geraete/:id/aktion', async (req, res) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        if (!options.authoritative()) return void res.status(409).json({ ok: false, message: 'Nur der autoritative Main bereitet Geräteaktionen vor.' })
        try {
            const result = proposeSmartSwitch(options.root(), { deviceId: String(req.params.id), functionId: req.body?.functionId, on: req.body?.on }, await options.owner(req))
            res.status(result.ok ? 200 : 409).json({ ok: result.ok, message: result.message, ...(result.proposal ? { confirmationId: result.proposal.id } : {}) })
        } catch { res.status(500).json({ ok: false, message: 'Aktion konnte nicht vorbereitet werden.' }) }
    })
    app.post('/api/desktop/smart-aktionen/:id/bestaetigen', async (req, res) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        if (req.body?.confirm !== 'ja') return void res.status(409).json({ ok: false, message: 'Separate Bestätigung dieser konkreten physischen Aktion erforderlich.' })
        try {
            const root = options.root()
            const result = await confirmSmartSwitch(root, String(req.params.id), await options.owner(req), options.authoritative,
                (d, a, signal, authorize) => (options.controlExecute || executeSmartSwitch)(root, d, a, signal, authorize))
            res.status(result.ok ? 200 : 409).json(result)
        } catch { res.status(500).json({ ok: false, message: 'Aktion nicht bestätigt; nicht automatisch wiederholen.' }) }
    })
    app.post('/api/desktop/smart-geraete/:id/zugang', async (req, res) => {
        if (!options.ownerOnly(req, res)) return
        res.setHeader('Cache-Control', 'no-store')
        if (!options.authoritative()) return void res.status(409).json({ ok: false, message: 'Nur der autoritative Main darf Gerätezugänge speichern.' })
        try {
            const root = options.root(), id = String(req.params.id), d = loadDevices(root).find(d => d.id === id)
            if (d?.hardware?.connector === 'matter-ip') {
                const result = submitMatterAccess(root, id, String(req.body?.fingerprint || ''), req.body?.values, await options.owner(req))
                if (!result.ok) return void res.status(409).json(result)
                const access = beginMatterAttempt(root, d)
                if (!access) return void res.status(409).json({ ok: false, message: 'Matter-Versuch bereits beansprucht. Kein zweiter Pairing-Versuch.' })
                const authorize = () => {
                    const current = loadDevices(root).find(v => v.id === id)
                    return options.authoritative() && Boolean(current && sensingDeviceFingerprint(current) === sensingDeviceFingerprint(d) && getMatterAccess(root, current)?.revision === access.revision)
                }
                try {
                    const connected = await (options.matterRead || readMatterPeer)({ host: d.host, port: d.port, identity: d.hardware.identity!, pairingCode: access.pairingCode }, matterFabricPath(root, d, access.revision), new AbortController().signal, authorize)
                    if (!authorize()) throw new Error('Matter authority changed')
                    finishMatterAttempt(root, d, access.revision, connected.peerId)
                    return void res.json({ ok: true, message: `Matter-Pairing und authentifizierte Funktionsabfrage bestätigt (${connected.functions.length} Endpunktfunktionen). Kein Schalten. Automatische Folgeabfragen verwenden nur diesen privaten Fabric-Zugang.` })
                } catch {
                    finishMatterAttempt(root, d, access.revision)
                    return void res.status(409).json({ ok: false, message: 'Matter-Pairing nicht bestätigt. Zustand prüfen; kein automatisches Wiederholen und kein Zurücksetzen bestehender Fabrics.' })
                }
            }
            const submit = d && approvedSmartRoute(root, d) === 'cloud' ? submitSmartCloudAccess : d?.hardware?.connector === 'esphome-native' ? submitEspHomeAccess : submitTuyaLocalAccess
            const result = submit(root, id, String(req.body?.fingerprint || ''), req.body?.values, await options.owner(req))
            res.status(result.ok ? 200 : 409).json(result)
        } catch { res.status(500).json({ ok: false, message: 'Zugang konnte nicht privat gespeichert werden.' }) }
    })
}
