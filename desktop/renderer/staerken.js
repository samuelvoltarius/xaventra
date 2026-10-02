// Wer kann was am besten (2.86 Paket J): Karte auf der Seite „System“.
// Liest /api/desktop/system/staerken (nur Owner). Nur Anzeige: je Fähigkeit
// die besten Knoten mit Begründung, die Main-Nachfolge und erkannte Änderungen.
;(function () {
  'use strict'

  function places(h, list) {
    if (!list.plaetze || !list.plaetze.length) {
      const why = (list.nichtGeeignet || []).slice(0, 2).map(item => `${item.knoten}: ${item.grund}`).join(' · ')
      return `<div class="row-sub">Kein geeigneter Knoten${why ? ` (${h.esc(why)})` : ''}.</div>`
    }
    return list.plaetze.map(place => `<div class="strength-place">
        <span class="pill ${place.platz === 1 ? 'good' : ''}">${h.esc(place.platz)}.</span>
        <strong>${h.esc(place.knoten)}</strong>
        <span class="row-sub">${h.esc((place.begruendung || []).join(' · '))}</span>
      </div>`).join('')
  }

  function tile(h, list) {
    return `<article class="tile strength-tile" aria-label="${h.attr(list.titel)}">
      <h3>${h.esc(list.titel)}</h3>
      ${places(h, list)}
    </article>`
  }

  function section(h) {
    const { data, error } = h.viewState('staerken')
    const head = `<div class="section-head"><h2>${h.icon('sparkles')}Wer kann was am besten</h2>${data?.generatedAt ? `<span class="section-note">Stand ${h.esc(h.relTime(data.generatedAt))}</span>` : ''}</div>`
    if (error && !data) return `<section class="section">${head}<div class="section-body">${h.viewErrorBlock(error)}</div></section>`
    if (!data) return h.skeletonSection('Wer kann was am besten')
    const stale = (data.knoten || []).filter(node => !node.frisch).map(node => node.id)
    const changes = (data.aenderungen || []).slice(0, 6).map(change => `<div class="row"><div><div class="row-title">${h.esc(change.knoten)}</div><div class="row-sub">${h.esc((change.text || []).join(' · '))}</div></div><div class="row-side"><span class="section-note">${h.esc(h.relTime(change.at))}</span></div></div>`).join('')
    return `<section class="section" aria-label="Wer kann was am besten">${head}
      <div class="section-body">
        ${(data.probleme || []).length ? `<div class="problem-note">${h.esc(data.probleme.join(' · '))}</div>` : ''}
        <div class="tiles">${(data.faehigkeiten || []).map(list => tile(h, list)).join('')}${data.main ? tile(h, data.main) : ''}</div>
        ${changes ? `<h3>Zuletzt erkannt</h3><div class="rows">${changes}</div>` : ''}
        <p class="section-note">${h.esc(data.hinweis || '')}${stale.length ? ` Nicht bewertet (veraltet): ${h.esc(stale.join(', '))}.` : ''}</p>
      </div>
    </section>`
  }

  window.Knotenstaerken = { section }
})()
