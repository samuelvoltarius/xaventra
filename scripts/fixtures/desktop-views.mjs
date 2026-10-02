// Synthetic owner views for the Desktop UI contract fixture.
// Shapes follow src/desktop/desktop-views.ts; every value is invented.
const ago = (now, minutes) => new Date(now - minutes * 60_000).toISOString()
const ahead = (now, minutes) => new Date(now + minutes * 60_000).toISOString()

export function createFixtureViews(now = Date.now()) {
  const cards = [
    {
      id: 'k0a1b2c3d4e5f', art: 'install-katalog', titel: 'Bildbetrachter auf dem Testknoten installieren', beleg: 'Du hast dreimal nach einer Vorschau für Fotos gefragt. Im Katalog ist ein geprüfter Bildbetrachter vorhanden (Paket aus der Distribution, signiert).',
      vorschlag: 'Paket installieren und danach prüfen, ob es startet.', wirkung: 'intern', node: 'fixture-one', quelle: 'software-scout', status: 'offen',
      createdAt: ago(now, 42), expiresAt: ahead(now, 180), antworten: ['ja', 'nein', 'spaeter', 'immer'], zustellung: 'sofort',
      decidedAt: null, antwort: null, entschiedenUeber: null, ergebnis: null,
    },
    {
      id: 'k1f2e3d4c5b6a', art: 'proxmox-start', titel: 'Labor-VM starten', beleg: 'Die Nachtwache-Prüfung „Labor erreichbar“ schlägt seit 03:10 fehl. Die VM ist gestoppt.',
      vorschlag: 'VM 150 starten und die Prüfung wiederholen.', wirkung: 'infra', node: 'fixture-main', quelle: 'verantwortung', status: 'offen',
      createdAt: ago(now, 12), expiresAt: ahead(now, 50), antworten: ['ja', 'nein', 'spaeter'], zustellung: 'sofort',
      decidedAt: null, antwort: null, entschiedenUeber: null, ergebnis: null,
    },
  ]
  const decided = [
    { id: 'k9a8b7c6d5e4f', art: 'self-heal', titel: 'Speicherdienst neu starten', beleg: '', vorschlag: '', wirkung: 'intern', node: 'fixture-one', quelle: 'selbstheilung', status: 'ja', createdAt: ago(now, 300), expiresAt: ago(now, 120), antworten: [], zustellung: 'sofort', decidedAt: ago(now, 280), antwort: 'ja', entschiedenUeber: 'telegram', ergebnis: { ok: true, text: 'Dienst läuft wieder, Prüfung bestanden.' } },
    { id: 'k8a7b6c5d4e3f', art: 'drucken', titel: 'Wochenplan drucken', beleg: '', vorschlag: '', wirkung: 'physisch', node: 'fixture-main', quelle: 'planer', status: 'nein', createdAt: ago(now, 900), expiresAt: ago(now, 700), antworten: [], zustellung: 'sofort', decidedAt: ago(now, 860), antwort: 'nein', entschiedenUeber: 'desktop', ergebnis: { ok: true, text: 'Abgelehnt.' } },
  ]
  const heute = {
    generatedAt: new Date(now).toISOString(),
    jetzt: {
      aufgaben: [{ text: 'Mission: Sicherung des Testknotens prüfen — Schritt 2/3: Prüfsumme vergleichen', quelle: 'Mission', seit: ago(now, 6) }],
      warteschlange: ['[queued] Bildbetrachter (Katalog) auf fixture-one'],
    },
    karten: cards,
    entschieden: decided,
    bericht: {
      art: new Date(now).getHours() < 14 ? 'morgen' : 'abend', titel: 'Bericht', seit: ago(now, 720), zahlen: { erledigt: 4, repariert: 1, installiert: 1, wartet: 2, ideen: 2, zurueckgehalten: 0, skills: 0, gemerkt: 1, gesammelt: 0, vertrauen: 0 },
      text: 'Bericht (seit gestern)\n\nErledigt:\n• Erinnerungen ausgelöst: 2\n• Nachtwache-Läufe: 1\n• Testknoten-Zertifikat erneuert\n\nSelbst repariert:\n• speicherdienst: geheilt – Neustart, Prüfung bestanden\n\nInstalliert:\n• Bildbetrachter installiert\n\nWartet auf dich:\n• Labor-VM starten – VM 150 starten und Prüfung wiederholen\n• Bildbetrachter installieren\n\nIdeen:\n• Fotos nach Datum ordnen (12 lose Ordner)\n\nNeu gemerkt (Entscheidungen):\n• Nachts keine Updates einspielen',
      geplant: { morgen: '07:30', abend: '20:00', an: true },
    },
    gedanken: [
      { at: ago(now, 4), quelle: 'mission', status: 'offen', text: 'Prüfsumme der Sicherung stimmt nicht mit gestern überein – vergleiche die Dateiliste.' },
      { at: ago(now, 12), quelle: 'verantwortung', status: 'wartet-auf-knopf', text: 'Labor-VM ist gestoppt — Vorschlag: starten.' },
      { at: ago(now, 40), quelle: 'software-scout', status: 'vorgeschlagen', text: 'Bildbetrachter fehlt — du hast dreimal nach einer Foto-Vorschau gefragt.' },
      { at: ago(now, 95), quelle: 'selbstheilung/fixture-one', status: 'geheilt', text: 'Speicherdienst hing, Neustart, Prüfung bestanden.' },
      { at: ago(now, 180), quelle: 'ideen', status: 'verworfen', text: 'Nächtlichen Bericht zusätzlich per Mail schicken — verworfen, Telegram reicht.' },
      { at: ago(now, 400), quelle: 'waechter', status: 'erledigt', text: 'Platte auf fixture-one bei 81 % — alte Protokolle aufgeräumt, jetzt 64 %.' },
      { at: ago(now, 600), quelle: 'planer', status: 'abgelaufen', text: 'Wochenplan drucken – Karte abgelaufen.' },
    ],
    probleme: [],
  }
  const arbeit = {
    an: true,
    missionen: [
      { id: 'm-0123456789ab', titel: 'Sicherung des Testknotens ist frisch', status: 'in-arbeit', anlass: ['Sicherung älter als 26 Stunden (erlaubt 24)'], fertigWenn: ['Sicherung jünger als 24 Stunden', 'Prüfsumme bestätigt'], schritte: [
        { id: 's1', titel: 'Diagnose: Sicherungsprotokoll lesen', status: 'erledigt', node: 'fixture-one', ergebnis: 'Lauf um 02:00 wegen vollem Ziel abgebrochen' },
        { id: 's2', titel: 'Prüfsumme vergleichen', status: 'laeuft', node: 'fixture-one', ergebnis: '' },
        { id: 's3', titel: 'Sicherung neu anstoßen', status: 'offen', node: 'fixture-one', ergebnis: '' },
      ], cursor: 1, versuch: 1, maxVersuche: 3, uebergabe: '', grund: '', node: 'fixture-main', createdAt: ago(now, 20), updatedAt: ago(now, 3), frist: ahead(now, 100), verlauf: [] },
      { id: 'm-ba9876543210', titel: 'Labor-VM erreichbar', status: 'wartet-auf-alfred', anlass: ['Prüfung „Labor erreichbar“ schlägt fehl'], fertigWenn: ['Labor antwortet'], schritte: [
        { id: 's1', titel: 'Diagnose: VM-Status lesen', status: 'erledigt', node: 'fixture-main', ergebnis: 'VM 150 ist gestoppt' },
        { id: 's2', titel: 'VM starten (Karte)', status: 'wartet', node: 'fixture-main', ergebnis: '' },
      ], cursor: 1, versuch: 1, maxVersuche: 3, uebergabe: '', grund: '', node: 'fixture-main', createdAt: ago(now, 14), updatedAt: ago(now, 12), frist: ahead(now, 60), verlauf: [] },
      { id: 'm-111122223333', titel: 'Platte fixture-one unter 80 %', status: 'abgeschlossen', anlass: [], fertigWenn: [], schritte: [], cursor: 0, versuch: 1, maxVersuche: 3, uebergabe: '', grund: '', node: 'fixture-one', createdAt: ago(now, 420), updatedAt: ago(now, 400), frist: null, verlauf: [] },
    ],
    verantwortungen: [
      { id: 'knoten-gesund:fixture-one', titel: 'fixture-one bleibt gesund', ziel: 'Platte, Speicher und Dienste im grünen Bereich', status: 'aktiv', herkunft: 'selbst abgeleitet', bisStufe: 'L1', kriterien: ['Platte < 85 %'], letztePruefung: { at: ago(now, 5), erfuellt: true, befunde: [] } },
      { id: 'geraet-ueberwachen:labor', titel: 'Labor-VM erreichbar', ziel: 'Das Labor antwortet auf Prüfungen', status: 'aktiv', herkunft: 'von Alfred', bisStufe: 'L2', kriterien: ['Nachtwache-Prüfung ok'], letztePruefung: { at: ago(now, 12), erfuellt: false, befunde: ['Labor erreichbar: Zeitüberschreitung'] } },
      { id: 'release-aktuell', titel: 'Release aktuell', ziel: 'Alle Knoten auf der freigegebenen Version', status: 'vorgeschlagen', herkunft: 'selbst abgeleitet', bisStufe: 'L1', kriterien: [], letztePruefung: null },
    ],
    auftraege: {
      aktiv: { id: 'mission-fixture', ziel: 'Fotos vom Sommer nach Datum ordnen', status: 'active', schritte: [{ text: 'Ordner einlesen', status: 'done' }, { text: 'Datum aus den Bildern lesen', status: 'active' }, { text: 'Neue Ordner anlegen', status: 'pending' }], aktuell: 1, createdAt: ago(now, 30), finishedAt: null, fortschritt: ['412 von 1.020 Bildern gelesen'] },
      verlauf: [{ id: 'mission-old', ziel: 'Rechnungen von September zusammenfassen', status: 'done', schritte: [{ text: 'a', status: 'done' }], aktuell: 0, createdAt: ago(now, 2000), finishedAt: ago(now, 1990), fortschritt: [] }],
    },
    delegationen: [{ id: 'dlg-0123456789ab', an: 'codex', auftrag: 'Testabdeckung für den Bildbetrachter-Wrapper ergänzen', status: 'fertig', stufe: 'L1', frist: ahead(now, 60), aktualisiert: ago(now, 50), mission: null, pruefung: { ergebnis: 'verifiziert', detail: 'Tests grün (14/14)' } }],
    geplant: [
      { id: 'sys-briefing-morgen', titel: 'Morgenbericht', art: 'briefing-morgen', an: true, rhythmus: 'täglich 07:30', naechster: ahead(now, 280), zuletzt: ago(now, 1160), letzterStatus: 'ok' },
      { id: 'job-1', titel: 'Erinnerung: Müll rausstellen', art: 'erinnerung', an: true, rhythmus: 'einmalig', naechster: ahead(now, 900), zuletzt: null, letzterStatus: '' },
    ],
    vertrauen: [{ art: 'self-heal-restart', text: 'Hängende Dienste neu starten', seit: ago(now, 4000) }],
    erlaubt: [{ art: 'install-katalog', was: 'kleines-werkzeug', seit: ago(now, 9000) }],
    probleme: [],
  }
  const series = id => Array.from({ length: 48 }, (_, i) => ({ at: ago(now, (47 - i) * 30), ram: Math.round(52 + 10 * Math.sin(i / 6) + (id === 'fixture-one' ? 8 : 0)), cpu: 0.3, platte: id === 'fixture-one' ? 64 : 41 }))
  const system = {
    waechter: {
      an: true, stand: ago(now, 2),
      knoten: [
        { id: 'fixture-main', at: ago(now, 2), alterMin: 2, cpu: 0.42, ram: 58, platten: [{ mount: '/', belegt: 41, freiGB: 210 }], tempC: 48, antwortMs: 3, dienstAus: [] },
        { id: 'fixture-one', at: ago(now, 3), alterMin: 3, cpu: 1.12, ram: 81, platten: [{ mount: '/', belegt: 64, freiGB: 88 }, { mount: '/daten', belegt: 92, freiGB: 40 }], tempC: 61, antwortMs: 7, dienstAus: ['backup-timer'] },
      ],
      erreichbarkeit: [
        { name: 'Router', art: 'ping', ok: true, ms: 1, alarm: false, detail: '' },
        { name: 'NAS', art: 'tcp', ok: true, ms: 4, alarm: false, detail: '' },
        { name: 'Labor-VM', art: 'tcp', ok: false, ms: null, alarm: true, detail: 'Zeitüberschreitung nach 3 s' },
      ],
      prognosen: [{ art: 'platte', text: 'fixture-one /daten', tage: 11, schwere: 'warning' }],
      zertifikate: [{ name: 'labor.example', tage: 9, schwere: 'warning' }],
      sicherungen: [{ name: 'fixture-one', alterStd: 26, maxStd: 24, schwere: 'warning' }],
      nachtwache: { at: ago(now, 240), gesamt: 12, fehler: [{ label: 'Labor erreichbar', status: 'fehler', text: 'Zeitüberschreitung' }] },
    },
    verlauf: { 'fixture-main': series('fixture-main'), 'fixture-one': series('fixture-one') },
    desktops: { enabled: true, desktops: [
      { id: 'spark', label: 'Arbeitsplatz', allowControl: true, agentInput: true, active: [] },
      { id: 'lab', label: 'Labor-VM', allowControl: false, agentInput: false, active: [] },
    ] },
    probleme: [],
  }
  const vms = {
    ok: true, pool: 'xaventra', usage: { ramGB: 12, cores: 6, diskGB: 160, count: 2 }, free: { ramGB: 52, cores: 10, diskGB: 864, count: 0 }, limits: { ramGB: 64, cores: 16, diskGB: 1024, hostRamReserveGB: 16 },
    nodes: [{ node: 'pve', status: 'online', cpu: 0.2, maxcpu: 32, mem: 60 * 1024 ** 3, maxmem: 128 * 1024 ** 3, uptime: 860000 }],
    guests: [
      { vmid: 110, name: 'xaventra-main', type: 'qemu', node: 'pve', status: 'running', maxcpu: 8, maxmem: 32 * 1024 ** 3, maxdisk: 256 * 1024 ** 3, uptime: 86000, template: false, eigene: false, selbst: true },
      { vmid: 150, name: 'labor', type: 'qemu', node: 'pve', status: 'stopped', maxcpu: 4, maxmem: 8 * 1024 ** 3, maxdisk: 64 * 1024 ** 3, uptime: 0, template: false, eigene: true, selbst: false },
      { vmid: 151, name: 'wegwerf-test', type: 'lxc', node: 'pve', status: 'running', maxcpu: 2, maxmem: 4 * 1024 ** 3, maxdisk: 32 * 1024 ** 3, uptime: 3600, template: false, eigene: true, selbst: false },
    ],
  }
  const gedaechtnis = {
    entscheidungen: [
      { id: 'd-1', text: 'Nachts keine Updates einspielen', warum: 'Alfred: „nachts nichts neu starten“', status: 'aktiv', bindend: true, wirksam: true, nichtWirksamGrund: '', quelle: 'owner-nachricht', at: ago(now, 600), gueltigBis: null, themen: ['update', 'nacht'], konflikt: null },
      { id: 'd-2', text: 'Drucken nur nach Rückfrage', warum: 'Karte „Wochenplan drucken“: Nein', status: 'aktiv', bindend: true, wirksam: true, nichtWirksamGrund: '', quelle: 'knopf', at: ago(now, 860), gueltigBis: null, themen: ['drucken'], konflikt: null },
      { id: 'd-3', text: 'Bis Sonntag keine neuen VMs', warum: 'Alfred: „diese Woche keine neuen Maschinen“', status: 'abgelaufen', bindend: true, wirksam: false, nichtWirksamGrund: 'Frist vorbei', quelle: 'owner-nachricht', at: ago(now, 12000), gueltigBis: ago(now, 3000), themen: ['vm'], konflikt: null },
    ],
    werkzeuge: [
      { id: 'sp-1', name: 'foto_datum', beschreibung: 'Liest das Aufnahmedatum aus Bilddateien.', warum: 'Fotos nach Datum ordnen', status: 'active', version: 2, herkunft: 'bedarf', wirkung: 'lesen', tests: { bestanden: 6, gesamt: 6, at: ago(now, 3000) }, aufrufe: { gesamt: 412, ok: 410, fehler: 2, zuletzt: ago(now, 5) }, gesperrt: '', karte: null, createdAt: ago(now, 5000) },
      { id: 'sp-2', name: 'strompreis', beschreibung: 'Holt den aktuellen Strompreis für die Region.', warum: 'Waschmaschine günstig starten', status: 'awaiting-approval', version: 1, herkunft: 'bedarf', wirkung: 'netz', tests: { bestanden: 3, gesamt: 3, at: ago(now, 60) }, aufrufe: null, gesperrt: '', karte: 'k3', createdAt: ago(now, 70) },
    ],
    probleme: [],
  }
  const memory = { scope: 'user:desktop:fixture-user', stats: { canonical: 2 }, records: [
    { kind: 'fact', content: 'Der Arbeitsplatz steht im Büro im ersten Stock.', status: 'canonical', confidence: 0.95, provenance: [{ source: 'gespraech' }] },
    { kind: 'preference', content: 'Berichte kurz halten, höchstens fünf Punkte je Abschnitt.', status: 'canonical', confidence: 0.9, provenance: [{ source: 'gespraech' }] },
  ] }
  const memoryAssets = { assets: [{ id: 'asset-1', name: 'Haus und Geräte', kind: 'wiki', version: 3, visibility: 'private', status: 'active', description: 'Wo welches Gerät steht und wie es heißt.', source: 'nova-desktop', updatedAt: ago(now, 2000) }], bindings: [] }
  return { heute, arbeit, system, vms, gedaechtnis, memory, memoryAssets }
}
