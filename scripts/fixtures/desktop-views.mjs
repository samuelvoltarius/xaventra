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
  // 2.85: Werkzeugkasten, Verbindungen (incl. KI-Modelle from Paket C), Erster Start. Invented values only.
  const tool = (over) => ({ detail: 'Geprüfter Katalogeintrag mit Installations-, Prüf- und Rückweg.', bedarf: [], aktualitaet: { status: 'aktuell', stand: '2026-10', text: 'Aktuell laut Katalog (Stand 10/2026).' }, katalogId: null, groesseMb: null, knopf: null, hinweis: '', warteschlange: null, empfohlen: false, ...over })
  const werkzeugkasten = {
    generatedAt: new Date(now).toISOString(), knoten: [{ id: 'fixture-main', bewertet: true }, { id: 'fixture-one', bewertet: true }],
    hinweis: 'Installiert wird erst nach deinem Ja auf der Karte.', probleme: [],
    gruppen: [
      { faehigkeit: 'stt', titel: 'Sprache verstehen', eintraege: [
        tool({ id: 'faster-whisper', name: 'faster-whisper', nutzen: 'Ich verstehe Sprachnachrichten, ohne sie in die Cloud zu schicken.', faehigkeit: 'stt', status: 'passt', statusText: 'passt auf fixture-one', knoten: 'fixture-one', empfohlen: true, bedarf: ['3× Sprachnachricht ohne Spracherkennung (14 Tage)'], katalogId: 'faster-whisper', groesseMb: 1500, knopf: { art: 'installieren', katalogId: 'faster-whisper' } }),
      ] },
      { faehigkeit: 'search', titel: 'Suchen', eintraege: [
        tool({ id: 'searxng', name: 'SearXNG', nutzen: 'Private Websuche ohne Key – wird vor Cloud-Suchen genutzt.', faehigkeit: 'search', status: 'laeuft', statusText: 'läuft im eigenen Netz (search.example.com)', knoten: 'fixture-main' }),
      ] },
      { faehigkeit: 'tts', titel: 'Sprechen und Medien', eintraege: [
        tool({ id: 'piper', name: 'Piper', nutzen: 'Ich kann Antworten vorlesen, lokal.', faehigkeit: 'tts', status: 'passt', statusText: 'passt auf fixture-main', knoten: 'fixture-main', katalogId: 'piper-tts', groesseMb: 120, knopf: { art: 'installieren', katalogId: 'piper-tts' } }),
        tool({ id: 'ffmpeg', name: 'ffmpeg', nutzen: 'Ich kann Audio und Video umwandeln.', faehigkeit: 'media', status: 'installiert', statusText: 'installiert auf fixture-main', knoten: 'fixture-main' }),
      ] },
    ],
  }
  const svg = (letter, color) => `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28"><rect width="28" height="28" rx="6" fill="${color}"/><text x="14" y="19" font-size="14" text-anchor="middle" fill="#fff" font-family="sans-serif">${letter}</text></svg>`).toString('base64')}`
  const verbindungen = {
    stand: new Date(now).toISOString(),
    gefunden: [
      { id: 'geraet:homeassistant:ha.example.com:8123', title: 'Home Assistant', kategorie: 'zuhause', wirkung: 'kann dann Lichter, Steckdosen und Geräte schalten und den Zustand lesen', fund: 'im Netz ha.example.com:8123', connectorId: 'home-assistant', datenklasse: 'lokal', icon: svg('H', '#41BDF5'), verbunden: false },
      { id: 'ki-modelle:lokal:ollama@http://gpu.example.com:11434', title: 'Ollama im eigenen Netz (gpu.example.com)', kategorie: 'ki-modelle', wirkung: '3 lokale Modelle — privat, ohne Frage nutzbar', fund: 'im Netz gpu.example.com:11434', datenklasse: 'lokal', verbunden: true },
      { id: 'ki-modelle:lokal:searxng@http://search.example.com:8088', title: 'SearXNG im eigenen Netz (search.example.com)', kategorie: 'hilfsdienste', wirkung: 'Private Websuche ohne Key — wird vor Cloud-Suchen genutzt', fund: 'im Netz search.example.com:8088', datenklasse: 'lokal', verbunden: true },
      { id: 'geraet:paperless:docs.example.com:8000', title: 'Paperless-ngx', kategorie: 'dateien', wirkung: 'kann dann Dokumente suchen und lesen', fund: 'im Netz docs.example.com:8000', connectorId: 'paperless', datenklasse: 'lokal', verbunden: false },
    ],
    verbunden: [
      { id: 'c-google-calendar', connectorId: 'google-calendar', title: 'Google Kalender', status: 'verbunden', trust: 'geprueft', datenklasse: 'cloud', icon: svg('K', '#4285F4'), aktion: 'keine', letzterTest: { werkzeuge: 6 },
        darf: { lesen: ['list_events'], fragt: ['create_event'], nie: ['delete_event'], sonst: 'Unbekannte Werkzeuge fragen dich; Privates geht nie in die Cloud.' } },
      { id: 'ki-modelle:cloud:openrouter', connectorId: 'llm:openrouter', title: 'OpenRouter', status: 'verbunden', trust: 'geprueft', datenklasse: 'cloud', icon: null, aktion: 'keine', llm: { provider: 'openrouter', trennbar: true, maske: '••••a1b2' },
        darf: { lesen: [], fragt: [], nie: [], sonst: 'Nur Rückfall, wenn lokal nicht reicht; Privates geht nie in die Cloud.' } },
    ],
    moeglich: {
      verzeichnis: { anzahl: 1240, stand: ago(now, 600), vollstaendig: true },
      gruppen: [
        { kategorie: 'zuhause', label: 'Zuhause', eintraege: [{ connectorId: 'home-assistant', title: 'Home Assistant', wirkung: 'Lichter, Steckdosen und Geräte schalten', datenklasse: 'lokal', auth: 'ha-login', trust: 'geprueft', icon: svg('H', '#41BDF5'), status: 'moeglich' }] },
        { kategorie: 'kalender', label: 'Kalender', eintraege: [{ connectorId: 'google-calendar', title: 'Google Kalender', wirkung: 'Termine lesen und – nach deinem Ja – eintragen', datenklasse: 'cloud', auth: 'oauth', trust: 'geprueft', icon: svg('K', '#4285F4'), status: 'verbunden' }] },
        { kategorie: 'entwicklung', label: 'Entwicklung', eintraege: [{ connectorId: 'github', title: 'GitHub', wirkung: 'Issues und Pull Requests lesen', datenklasse: 'cloud', auth: 'oauth', trust: 'geprueft', icon: svg('G', '#24292F'), status: 'moeglich', hinweis: 'Vorher einmal eine GitHub-OAuth-App anlegen (Owner) und ihre Client-ID eintragen.' }] },
        { kategorie: 'ki-modelle', label: 'KI-Modelle', eintraege: [
          { connectorId: 'llm:anthropic', title: 'Anthropic (Claude)', wirkung: 'Claude-Modelle über die Anthropic-API — nur nicht-private Inhalte', datenklasse: 'cloud', auth: 'token', trust: 'geprueft', icon: null, status: 'moeglich', llm: { provider: 'anthropic', konto: null, kontoHinweis: 'Anthropic erlaubt Drittanwendungen keine Anmeldung mit Claude-Konto — bitte einen API-Key verwenden.', keyUrl: 'https://platform.claude.com/settings/keys' } },
          { connectorId: 'llm:openai', title: 'OpenAI (ChatGPT)', wirkung: 'Cloud-Modelle von OpenAI als Rückfall — nur nicht-private Inhalte', datenklasse: 'cloud', auth: 'token', trust: 'geprueft', icon: null, status: 'moeglich', llm: { provider: 'openai', konto: 'codex-app-server', kontoHinweis: 'Anmeldung mit ChatGPT-Konto nur über die offizielle Codex-App.', keyUrl: 'https://platform.openai.com/api-keys' } },
        ] },
      ],
    },
  }
  const onboarding = {
    firstStart: true, state: 'pending', ownerName: 'Alex',
    doctor: { running: false, report: { startedAt: ago(now, 5), finishedAt: ago(now, 4), hardware: { platform: 'linux', arch: 'x64', cpus: 8, memoryGb: 16, gpu: null }, localModel: null, items: [
      { step: 'hardware', status: 'getan', text: 'Rechner erkannt: 8 Kerne, 16 GB Speicher, keine GPU.' },
      { step: 'modell', status: 'vorgeschlagen', catalogId: 'ollama-model:qwen3.5-9b', proposalId: 'iq-0123456789ab', text: 'Kein lokales Modell gefunden. Vorschlag: qwen3.5-9b (passt zu 16 GB). Ein Ja auf der Karte genügt, dann installiere ich es.' },
      { step: 'einrichtung', status: 'getan', text: 'Gedächtnis eingerichtet: eigenes Einbettungsmodell, lokal.' },
    ] } },
    telegram: { configured: false, running: false, botUsername: null, paired: false, pairedWith: null, pairingPending: false, pairingExpiresAt: null, restartNeeded: false },
    connections: { available: true, gefunden: 2, verbunden: 4, beispiele: ['Home Assistant', 'Paperless-ngx'], view: 'verbindungen' },
    questions: [{ id: 'name', done: true }, { id: 'telegram', done: false }, { id: 'verbindungen', done: false, available: true }],
  }
  // 2.86 Paket M: Einrichtung, Beispielsätze, Tipp (Testdaten, Doku-IPs).
  const gefuehrt = {
    einrichtung: { erledigt: 2, gesamt: 3, fertig: false, kopf: '2 von 3 erledigt', punkte: [
      { key: 'ki', titel: 'KI-Modell läuft', erledigt: true, satz: 'Ich kann denken und antworten.' },
      { key: 'telegram', titel: 'Telegram gekoppelt', erledigt: true, satz: 'Du erreichst mich auch unterwegs.' },
      { key: 'geraet:dev-00000000bb', titel: 'Hue Bridge verbinden', erledigt: false, satz: 'Ich habe Hue Bridge gefunden; ein Knopf, dann frage ich dich einmal.', knopf: { label: 'Verbinden', aktion: { art: 'verbinden', key: 'geraet:dev-00000000bb' } } },
    ] },
    beispiele: [],
    tipp: null,
  }
  return { heute, arbeit, system, vms, gedaechtnis, memory, memoryAssets, werkzeugkasten, verbindungen, onboarding, gefuehrt }
}
