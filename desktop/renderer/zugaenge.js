// Zugänge (2.88 „Verbinden ohne Technik“): Verbindungen → „Proxmox“ und „Passwort-Tresor“.
// Eigene Datei; connections.js ruft nur section(h) und mount(h) auf.
// Proxmox: ein Token reicht. Adresse kommt aus der Netzwerkerkennung, den
// Fingerabdruck liest sie selbst und zeigt Anfang/Ende einmal zum Bestätigen.
// Tresor: Einträge mit Kurzname; Passwort/Token geht einmal an den Main
// (0600) oder bleibt im Passwortmanager — Felder sind nie vorbefüllt, Werte
// tauchen nie im HTML auf.
;(() => {
  const PVE = '/api/desktop/proxmox'
  const TRESOR = '/api/desktop/tresor'
  const local = { pve: null, tresor: null, error: '', loading: false, tried: 0, busy: false, cardId: '', pveOpen: false, tresorOpen: false }

  async function load(h, force = false) {
    if (local.loading || (!force && local.tried && Date.now() - local.tried < 20_000)) return
    local.loading = true
    local.tried = Date.now()
    try {
      const [pve, tresor] = await Promise.all([h.api.get(PVE), h.api.get(TRESOR)])
      local.pve = pve; local.tresor = tresor; local.error = ''
    } catch (error) { local.error = h.errorText ? h.errorText(error) : String(error?.message || error) }
    finally { local.loading = false; h.rerender() }
  }

  function input(h, label, name, value, options = {}) {
    const type = options.type || 'text'
    return `<label>${h.esc(label)}<input name="${h.attr(name)}" type="${type}" value="${type === 'password' ? '' : h.attr(value || '')}" autocomplete="off" maxlength="${options.max || 300}"${options.placeholder ? ` placeholder="${h.attr(options.placeholder)}"` : ''}${options.list ? ` list="${h.attr(options.list)}"` : ''}></label>`
  }

  function proxmoxSection(h) {
    const d = local.pve
    const head = `<div class="section-head"><h2 id="conn-proxmox">${h.icon('layers')}Proxmox</h2><span class="section-note">deine VMs sehen, im Pool „xaventra“ steuern – immer mit deinem Ja</span></div>`
    if (!d) return `<section class="section" aria-labelledby="conn-proxmox">${head}<div class="section-body" aria-busy="true"><div class="skeleton"></div></div></section>`
    const fp = d.fingerabdruck
    const status = d.ausConfig ? '<span class="pill good">über die Einstellungen eingerichtet</span>'
      : d.eingerichtet ? '<span class="pill good">verbunden</span>' : fp && !fp.bestaetigt ? '<span class="pill warn">Fingerabdruck bestätigen</span>' : ''
    const summary = d.adresse || d.ausConfig ? `<div class="row"><div><div class="row-title">${h.esc(d.adresse || 'Proxmox')}</div>
        ${fp ? `<div class="row-sub">Fingerabdruck beginnt mit <span class="mono">${h.esc(fp.anfang)}</span>, endet mit <span class="mono">${h.esc(fp.ende)}</span>${fp.bestaetigt ? ' · bestätigt' : ''}</div>` : ''}
        ${d.status ? `<div class="row-sub">${h.esc(d.status.text)}</div>` : ''}</div><div class="row-side">${status}</div></div>` : ''
    const confirm = fp && !fp.bestaetigt && local.cardId ? `<div class="answer-row" role="group" aria-label="Fingerabdruck bestätigen"><span class="section-note">Stimmt der Fingerabdruck mit Proxmox überein?</span>
        <button class="primary" data-pve-answer="ja" ${local.busy ? 'disabled' : ''}>${h.icon('check', 'sm')}Ja</button>
        <button class="secondary" data-pve-answer="nein" ${local.busy ? 'disabled' : ''}>${h.icon('x', 'sm')}Nein</button></div>`
      : fp && !fp.bestaetigt ? '<p class="section-note">Die Karte zum Bestätigen liegt unter „Heute“.</p>' : ''
    const vorschlaege = d.vorschlaege || []
    const showForm = !d.ausConfig && (local.pveOpen || !d.eingerichtet)
    const form = showForm ? `<form class="form" data-pve-form>
        ${input(h, 'Adresse des Proxmox-Servers', 'adresse', d.adresse || vorschlaege[0] || '', { placeholder: '192.0.2.10', list: 'pve-vorschlaege', max: 200 })}
        ${vorschlaege.length ? `<datalist id="pve-vorschlaege">${vorschlaege.map(item => `<option value="${h.attr(item)}"></option>`).join('')}</datalist>` : ''}
        ${input(h, 'API-Token', 'token', '', { type: 'password', placeholder: d.tokenGespeichert ? 'gespeichert – nur zum Ändern einfügen' : 'benutzer@pam!xaventra=…' })}
        <div class="toolbar"><button class="primary" type="submit" ${local.busy ? 'disabled' : ''}>Speichern</button></div></form>` : ''
    const guide = d.ausConfig ? '' : `<details${d.eingerichtet ? '' : ' open'}><summary>Token in Proxmox anlegen (3 Schritte)</summary><ol>${(d.anleitung || []).map(step => `<li>${h.esc(step)}</li>`).join('')}</ol></details>`
    const tools = d.eingerichtet || d.adresse ? `<div class="toolbar">${d.eingerichtet ? `<button class="secondary" data-pve-check ${local.busy ? 'disabled' : ''}>Verbindung prüfen</button>` : ''}
        ${d.ausConfig ? '' : `<button class="link-button" data-pve-edit>${local.pveOpen ? 'Fertig' : 'Ändern'}</button><button class="link-button" data-pve-delete>Zugang löschen</button>`}</div>` : ''
    return `<section class="section" aria-labelledby="conn-proxmox">${head}<div class="section-body">${summary}${confirm}${form}${tools}${guide}
      <p class="section-note">Danach reicht ein Satz: „starte meine Test-VM“ oder „mach einen Snapshot vor dem Update“. Hart ausschalten und Löschen von Snapshots mache ich nie.</p></div></section>`
  }

  const QUELLE = { datei: 'hier gespeichert', bitwarden: 'Bitwarden/Vaultwarden', '1password': '1Password' }

  function tresorSection(h) {
    const d = local.tresor
    const head = `<div class="section-head"><h2 id="conn-tresor">${h.icon('shield')}Passwort-Tresor</h2><span class="section-note">ich sehe nur Kurznamen – nie ein Passwort</span></div>`
    if (!d) return `<section class="section" aria-labelledby="conn-tresor">${head}<div class="section-body" aria-busy="true"><div class="skeleton"></div></div></section>`
    const rows = (d.eintraege || []).map(item => `<div class="row"><div><div class="row-title">${h.esc(item.label)} <span class="mono">${h.esc(item.id)}</span></div>
        <div class="row-sub">${h.esc(QUELLE[item.quelle] || item.quelle)} · nur für ${h.esc((item.dienste || []).join(', '))}</div></div>
        <div class="row-side"><button class="ghost" data-tresor-delete="${h.attr(item.id)}">Entfernen</button></div></div>`).join('')
    const form = local.tresorOpen || !(d.eintraege || []).length ? `<form class="form" data-tresor-form>
        ${input(h, 'Kurzname (z. B. github-main)', 'id', '', { max: 40 })}
        ${input(h, 'Name', 'label', '', { max: 60 })}
        <label>Woher<select name="quelle"><option value="datei">Hier speichern (geschützte Datei, nur dieser Rechner)</option><option value="bitwarden">Bitwarden / Vaultwarden</option><option value="1password">1Password</option></select></label>
        ${input(h, 'Für welche Dienste (Adressen, mit Komma)', 'dienste', '', { placeholder: 'github.com' })}
        <details><summary>Werte</summary>
          ${input(h, 'Benutzername (nur „hier speichern“)', 'benutzer', '', { max: 200 })}
          ${input(h, 'Passwort oder Token (nur „hier speichern“)', 'geheim', '', { type: 'password', max: 4096 })}
          ${input(h, 'Bitwarden: Eintrags-ID · 1Password: op://Tresor/Eintrag/password', 'ref', '', { max: 200 })}
        </details>
        <div class="toolbar"><button class="primary" type="submit" ${local.busy ? 'disabled' : ''}>Speichern</button></div></form>` : ''
    const hints = (d.hinweise || []).map(text => `<li>${h.esc(text)}</li>`).join('')
    return `<section class="section" aria-labelledby="conn-tresor">${head}${rows ? `<div class="rows">${rows}</div>` : ''}<div class="section-body">${hints ? `<ul class="section-note">${hints}</ul>` : ''}${form}
      ${(d.eintraege || []).length ? `<div class="toolbar"><button class="link-button" data-tresor-add>${local.tresorOpen ? 'Fertig' : 'Eintrag hinzufügen'}</button></div>` : ''}</div></section>`
  }

  function section(h) {
    if (local.error && !local.pve) return `<section class="section"><div class="section-body"><div class="empty-note">${h.esc(local.error)}</div></div></section>`
    return proxmoxSection(h) + tresorSection(h)
  }

  async function savePve(h, form) {
    const values = Object.fromEntries(new FormData(form).entries())
    const body = { adresse: String(values.adresse || '').trim() }
    if (values.token) body.token = String(values.token).trim()
    local.busy = true; h.rerender()
    try {
      const result = await h.api.post(PVE, body)
      local.pve = result.proxmox || local.pve
      local.cardId = result.cardId || ''
      local.pveOpen = false
      h.toast(result.meldung || 'Gespeichert.')
    } catch (error) { h.fail(error) }
    finally { local.busy = false; h.rerender() }
  }

  async function answerPve(h, value) {
    if (!local.cardId) return
    local.busy = true; h.rerender()
    try {
      const result = await h.api.post(`/api/desktop/karten/${encodeURIComponent(local.cardId)}/antwort`, { answer: value })
      h.toast(result?.message || 'Antwort gespeichert.')
      local.cardId = ''
    } catch (error) { h.fail(error) }
    finally { local.busy = false; await load(h, true) }
  }

  async function saveTresor(h, form) {
    const values = Object.fromEntries(new FormData(form).entries())
    const body = {}
    for (const key of ['id', 'label', 'quelle', 'dienste', 'benutzer', 'ref']) if (typeof values[key] === 'string' && values[key].trim()) body[key] = values[key].trim()
    if (values.geheim) body.geheim = String(values.geheim)
    local.busy = true; h.rerender()
    try {
      const result = await h.api.post(TRESOR, body)
      if (result?.ok === false) h.toast(result.meldung || 'Nicht gespeichert.')
      else { local.tresor = result; local.tresorOpen = false; h.toast('Gespeichert. Das Passwort zeige ich nie wieder an.') }
    } catch (error) { h.fail(error) }
    finally { local.busy = false; h.rerender() }
  }

  function mount(h) {
    const pve = document.querySelector('[aria-labelledby="conn-proxmox"]')
    const tresor = document.querySelector('[aria-labelledby="conn-tresor"]')
    if (!pve || !tresor) return void load(h)
    pve.querySelector('[data-pve-form]')?.addEventListener('submit', event => { event.preventDefault(); void savePve(h, event.currentTarget) })
    pve.querySelectorAll('[data-pve-answer]').forEach(button => button.addEventListener('click', () => answerPve(h, button.dataset.pveAnswer)))
    pve.querySelector('[data-pve-edit]')?.addEventListener('click', () => { local.pveOpen = !local.pveOpen; h.rerender() })
    pve.querySelector('[data-pve-check]')?.addEventListener('click', async () => {
      local.busy = true; h.rerender()
      try { const result = await h.api.post(`${PVE}/pruefen`, {}); h.toast(result.text) } catch (error) { h.fail(error) }
      finally { local.busy = false; h.rerender() }
    })
    pve.querySelector('[data-pve-delete]')?.addEventListener('click', async () => {
      try { const result = await h.api.delete(PVE); local.pve = result.proxmox; local.cardId = ''; h.toast('Proxmox-Zugang gelöscht.') } catch (error) { h.fail(error) }
      h.rerender()
    })
    tresor.querySelector('[data-tresor-form]')?.addEventListener('submit', event => { event.preventDefault(); void saveTresor(h, event.currentTarget) })
    tresor.querySelector('[data-tresor-add]')?.addEventListener('click', () => { local.tresorOpen = !local.tresorOpen; h.rerender() })
    tresor.querySelectorAll('[data-tresor-delete]').forEach(button => button.addEventListener('click', async () => {
      try { local.tresor = await h.api.delete(`${TRESOR}/${encodeURIComponent(button.dataset.tresorDelete)}`); h.toast('Eintrag entfernt.') } catch (error) { h.fail(error) }
      h.rerender()
    }))
    void load(h)
  }

  window.XaventraZugaenge = Object.freeze({ section, mount })
})()
