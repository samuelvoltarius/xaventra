// Telefon (2.87 Paket P): Verbindungen → „Telefon“.
// Eigene Datei; connections.js ruft nur section(h) und mount(h) auf.
// Drei Felder reichen (Server, Login, Passwort). Das Passwort geht einmal an
// den Main (Secrets-Ablage) und wird nie wieder angezeigt — das Feld bleibt leer.
;(() => {
  const PATH = '/api/desktop/telefon'
  const local = { data: null, error: '', loading: false, tried: 0, busy: false, open: false }

  async function load(h, force = false) {
    if (local.loading || (!force && local.tried && Date.now() - local.tried < 20_000)) return
    local.loading = true
    local.tried = Date.now()
    try { local.data = await h.api.get(PATH); local.error = '' }
    catch (error) { local.error = h.errorText ? h.errorText(error) : String(error?.message || error) }
    finally { local.loading = false; h.rerender() }
  }

  function field(h, label, name, value, options = {}) {
    const type = options.type || 'text'
    return `<label>${h.esc(label)}<input name="${h.attr(name)}" type="${type}" value="${type === 'password' ? '' : h.attr(value || '')}" autocomplete="off" maxlength="${options.max || 200}"${options.placeholder ? ` placeholder="${h.attr(options.placeholder)}"` : ''}${options.mode ? ` inputmode="${options.mode}"` : ''}></label>`
  }

  function section(h) {
    const d = local.data
    const head = `<div class="section-head"><h2 id="conn-telefon">${h.icon('phone')}Telefon</h2><span class="section-note">mit mir telefonieren – nur von deinen Nummern</span></div>`
    if (local.error && !d) return `<section class="section" aria-labelledby="conn-telefon">${head}<div class="section-body"><div class="empty-note">${h.esc(local.error)}</div></div></section>`
    if (!d) return `<section class="section" aria-labelledby="conn-telefon">${head}<div class="section-body" aria-busy="true"><div class="skeleton"></div></div></section>`
    const status = d.pruefung ? `<span class="pill ${d.pruefung.ok ? 'good' : 'warn'}">${h.esc(d.pruefung.ok ? 'angemeldet' : 'nicht angemeldet')}</span>` : d.eingerichtet ? '<span class="pill">noch nicht geprüft</span>' : ''
    const summary = d.eingerichtet
      ? `<div class="row"><div><div class="row-title">${h.esc(d.sip.anbieter || d.sip.server || 'Telefonanlage')}</div><div class="row-sub">${h.esc(d.weg === 'asterisk' ? 'über deine Telefonanlage' : 'direkt')} · ${d.aktiv ? 'eingeschaltet' : 'ausgeschaltet'}${d.pruefung ? ` · ${h.esc(d.pruefung.text)}` : ''}</div></div><div class="row-side">${status}</div></div>`
      : ''
    const hints = (d.hinweise || []).map(text => `<li>${h.esc(text)}</li>`).join('')
    const form = local.open || !d.eingerichtet ? `<form class="form" data-tel-form>
        ${field(h, 'Server', 'server', d.sip.server, { placeholder: 'sip.zadarma.com' })}
        ${field(h, 'Login (SIP-Kennung)', 'login', d.sip.login)}
        ${field(h, 'Passwort', 'passwort', '', { type: 'password', placeholder: d.passwortGespeichert ? 'gespeichert – nur zum Ändern eintippen' : '' })}
        <details><summary>Mehr (optional)</summary>
          ${field(h, 'Eigene Telefonnummer beim Anbieter', 'rufnummer', d.sip.rufnummer, { placeholder: '+43 …', mode: 'tel' })}
          ${field(h, 'Wer darf anrufen (Owner-Nummern, mit Komma)', 'ownerNummern', (d.ownerNummern || []).join(', '), { placeholder: '+43 …', mode: 'tel', max: 300 })}
          ${field(h, 'Anzeigename', 'anzeigename', d.sip.anzeigename, { max: 60 })}
          <label>Weg<select name="weg"><option value="direkt"${d.weg === 'direkt' ? ' selected' : ''}>direkt (Standard)</option><option value="asterisk"${d.weg === 'asterisk' ? ' selected' : ''}>über meine Telefonanlage (Asterisk)</option></select></label>
          <label class="check"><input type="checkbox" name="aktiv"${d.aktiv ? ' checked' : ''}> Telefon eingeschaltet</label>
        </details>
        <div class="toolbar"><button class="primary" type="submit" ${local.busy ? 'disabled' : ''}>Speichern</button></div></form>` : ''
    const vorlage = d.vorlage ? `<details><summary>Vorlage für deine Telefonanlage</summary><p class="section-note">Diese Änderung machst du selbst in der Anlage. Alles bleibt auf diesem Rechner (127.0.0.1), kein Port nach außen.</p><pre class="mono">${h.esc(d.vorlage)}</pre></details>` : ''
    return `<section class="section" aria-labelledby="conn-telefon">${head}<div class="section-body">${summary}${hints ? `<ul class="section-note">${hints}</ul>` : ''}${form}
      <div class="toolbar">${d.eingerichtet ? `<button class="secondary" data-tel-check ${local.busy ? 'disabled' : ''}>Anmeldung prüfen</button><button class="link-button" data-tel-edit>${local.open ? 'Fertig' : 'Ändern'}</button><button class="link-button" data-tel-delete>Zugang löschen</button>` : ''}</div>${vorlage}</div></section>`
  }

  async function save(h, form) {
    const values = Object.fromEntries(new FormData(form).entries())
    const body = {}
    for (const key of ['server', 'login', 'rufnummer', 'anzeigename', 'weg']) if (typeof values[key] === 'string') body[key] = values[key].trim()
    if (values.passwort) body.passwort = String(values.passwort)
    if (typeof values.ownerNummern === 'string') body.ownerNummern = values.ownerNummern.split(/[,;]/).map(item => item.trim()).filter(Boolean)
    body.aktiv = form.querySelector('[name="aktiv"]')?.checked === true
    local.busy = true; h.rerender()
    try {
      const result = await h.api.patch(PATH, body)
      if (result?.ok === false) h.toast(result.meldung || 'Nicht gespeichert.')
      else { local.data = result.telefon; local.open = false; h.toast('Gespeichert.') }
    } catch (error) { h.fail(error) }
    finally { local.busy = false; h.rerender() }
  }

  async function check(h) {
    local.busy = true; h.rerender()
    try { const result = await h.api.post(`${PATH}/pruefen`, {}); h.toast(result.text) } catch (error) { h.fail(error) }
    finally { local.busy = false; await load(h, true) }
  }

  function mount(h) {
    const root = document.querySelector('[aria-labelledby="conn-telefon"]')
    if (!root) return void load(h)
    root.querySelector('[data-tel-form]')?.addEventListener('submit', event => { event.preventDefault(); void save(h, event.currentTarget) })
    root.querySelector('[data-tel-check]')?.addEventListener('click', () => check(h))
    root.querySelector('[data-tel-edit]')?.addEventListener('click', () => { local.open = !local.open; h.rerender() })
    root.querySelector('[data-tel-delete]')?.addEventListener('click', async () => {
      try { const result = await h.api.delete(PATH); local.data = result.telefon; h.toast('Telefon-Zugang gelöscht.') } catch (error) { h.fail(error) }
      h.rerender()
    })
    void load(h)
  }

  window.XaventraTelefon = Object.freeze({ section, mount })
})()
