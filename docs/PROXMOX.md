# Proxmox (Phase 6c)

Xaventra erkennt, ob und wo es als Gast auf Alfreds Proxmox VE läuft, sieht alle
Gäste dort (nur lesend) und verwaltet **eigene** VMs im Pool `xaventra`. Jede
schreibende Aktion ist eine Knopf-Karte und läuft erst nach dem Ja des Owners.

Standard: **aus**. Code: `src/infra/proxmox.ts` (Adapter),
`src/infra/proxmox-command.ts` (`/vms`, Karten), `src/sensing/adapters/proxmox.ts`
(Wahrnehmen), `src/core/node-profile.ts` (Erkennung).

## Was Xaventra darf

| Aktion | Wer | Stufe | Wirkung (Policy) | Karte |
|---|---|---|---|---|
| Übersicht, Snapshots, Inventar, Deckel lesen | alle Gäste | — | lesen | nein |
| Snapshot anlegen | Pool-Gäste | L1 | `infra:vm-snapshot` | ja |
| Starten / sauber herunterfahren (kein Hart-Stopp) | Pool-Gäste | L2 | `infra:vm-power` | ja |
| Auf Snapshot zurückrollen | Pool-Gäste | L2 | `infra:vm-rollback` | ja |
| VM anlegen (Cloud-Image oder Klon einer Pool-Vorlage) | Pool `xaventra`, Tag `xaventra-created`, Netz `vmbr0` | L2 | `infra:vm-create` | ja |
| VM vergrößern (CPU/RAM/Disk, nur größer) | Pool-VMs | L2 | `infra:vm-config` | ja |
| VM entfernen | nur Tag `xaventra-created`, nie `protection=1`, nie die eigene VM, nur gestoppt | L2 | `infra:vm-destroy` | ja |

Alle Karten haben die Wirkungsart `infra` („Infrastruktur (VMs) — fragt immer“),
**nie** „Immer erlauben“. Die Aktionsarten (`aktion.kind`) sind `pve-snapshot`,
`pve-start`, `pve-herunterfahren`, `pve-rollback`, `pve-anlegen`, `pve-anpassen`,
`pve-entfernen`; die Tabelle steht als `PROXMOX_ACTIONS` im Code und wird bei der
Integration an die Aktions-Policy gehängt.

Vor Rollback und Vergrößern einer **eigenen** VM (Pool + Tag `xaventra-created`
oder `xaventra-lab`) legt Xaventra automatisch einen Sicherheits-Snapshot
`xv-auto-…` an (L1, vom selben Ja gedeckt). Scheitert er, unterbleibt die Änderung.

**Nie** (kein Codepfad): Gäste außerhalb des Pools anfassen; Gäste ohne Tag
`xaventra-created`, mit `protection=1` oder die eigene VM entfernen; andere Netze als
`vmbr0`; Disks verkleinern; Hart-Stopp, Reset, Migration; Snapshots löschen;
Befehle auf dem Proxmox-Host.

Der Adapter prüft Pool, Tag, Schutz, Deckel und Host-Reserve **selbst** (frisch
gelesen, vor der Karte und noch einmal direkt vor der Ausführung) — zusätzlich zur
Proxmox-Rolle. Jede Ausführung wird über den Proxmox-Task (UPID) bis
`exitstatus: OK` verifiziert.

### Ressourcen-Deckel

Summe aller Gäste mit Tag `xaventra-created` (Standard): ≤ 64 GB RAM, ≤ 16 Kerne,
≤ 1 TB Disk; zusätzlich müssen nach dem Anlegen/Vergrößern auf dem Host noch
`hostRamReserveGB` (Standard 16 GB) frei bleiben. Überschreitung → Ablehnung mit
Grund, **ohne** schreibende Anfrage. Die Labor-VM 110 (`xaventra-lab`) zählt nicht
zum Deckel, die Host-Reserve gilt aber auch für sie.

### root nur auf eigenen Maschinen

Root bzw. `sudo` ohne Passwort gibt es **nur** auf eigenen Maschinen: Pool-Gäste
mit Tag `xaventra-created` oder `xaventra-lab` (`isOwnMachine`,
`privilegedOnOwnMachine`). Spark, ns1, ns2 und NAS sind keine solchen Gäste und
behalten ihre Härtung; daran ändert dieser Teil nichts.

Neue VMs bekommen per cloud-init den Benutzer `nova` mit dem Owner-SSH-Schlüssel.
Für `sudo: "ALL=(ALL) NOPASSWD:ALL"`, Gruppen `sudo,docker` und Zeitzone
`Europe/Vienna` braucht Proxmox ein Snippet (die API kann Snippets nicht hochladen):

1. `/vms cloudinit` zeigt den Inhalt (nur öffentliche Schlüssel).
2. Auf dem Host als `/var/lib/vz/snippets/xaventra-nova.yaml` ablegen (Storage
   `local` braucht den Inhaltstyp `snippets`).
3. In der Config `infra.proxmox.create.cicustom = "user=local:snippets/xaventra-nova.yaml"`.

Ohne Snippet setzt Xaventra `ciuser=nova` + `sshkeys` (Standard-sudo des
Cloud-Images, ohne Zeitzone/docker-Gruppe).

## Wo laufe ich?

`/knoten` zeigt je Knoten `virtualization`:

- `kind`: `kvm` (DMI `sys_vendor = QEMU` bzw. `product_name` mit KVM/QEMU),
  `container` (Docker-Laufzeit oder `/run/systemd/container`), `none` (Blech),
  `unknown` (anderer Hypervisor, `hypervisor`-CPU-Flag ohne QEMU, nichts lesbar).
  Gelesen wird nur `/sys/class/dmi/id/*`, `/sys/hypervisor/type`, `/proc/cpuinfo` —
  kein Kindprozess.
- `platform: 'proxmox'`, `vmid`, `pveNode`, `ownMachine` nur, wenn der konfigurierte
  Proxmox-Host per API genau **einen** Gast findet, dessen `netN`-MAC zu einer
  eigenen Netzschnittstelle passt. Mehrdeutig = nicht gefunden.

Empfänger begrenzen das Feld (`sanitizeNodeProfile`).

## Einrichtung ohne Config (2.88)

Der einfache Weg — keine Config-Datei, keine Umgebungsvariable:

1. In Proxmox einen API-Token anlegen (die App zeigt die 3 Schritte unter
   „Verbindungen → Proxmox“: Pool `xaventra`, Token mit „Privilegien trennen“,
   Rollen PVEAuditor auf `/` und PVEVMAdmin auf `/pool/xaventra`).
2. In der App Token einfügen. Die Adresse schlägt die Netzwerkerkennung vor
   (Port 8006, erkannt am Zertifikat der Proxmox-CA).
3. Xaventra liest den TLS-Fingerabdruck selbst (nur Handshake, nichts
   gesendet) und zeigt Anfang und Ende auf **einer** Karte. Nach dem Ja ist
   Lesen und Steuern im Pool sofort aktiv — ohne Neustart. Fehlt der Pool,
   kommt eine Karte mit den Schritten; Xaventra legt ihn nicht selbst an.

Der Token liegt in `<data>/secrets/connections/c-proxmox-adapter.json`
(0600), Adresse und Fingerabdruck in `<data>/connections/proxmox.json`.
`infra.proxmox` aus der Config und `XAVENTRA_PVE_TOKEN` funktionieren weiter
und haben Vorrang; `infra.proxmox.enabled: false` schaltet auch den App-Weg ab.
Steuern geht danach im Gespräch („starte meine Test-VM“, „mach einen Snapshot
vor dem Update“, Werkzeug `proxmox_vm`) — jede Änderung bleibt eine Karte, die
Regeln oben gelten unverändert.

## Einrichtung über Config (Fachweg)

### 1. Rechte auf dem Proxmox-Host

So hat Claude es am 01.10.2026 gesetzt (laut den Setup-Skripten; mit
`pveum acl list` / `pveum role list` abgleichen):

```bash
# Pool + Labor-VM (110) schützen und markieren
pveum pool add xaventra --comment "Xaventra Labor-VMs"
qm set 110 --protection 1 --tags xaventra-lab

# Benutzer ohne Passwort, Token mit Privilege Separation
pveum user add xaventra@pve --comment "Xaventra Agent, nur Lesen + Pool xaventra"
pveum user token add xaventra@pve agent --privsep 1 --comment "Xaventra Agent" --output-format json
#   -> Secret einmalig in eine Datei mit Modus 600 schreiben, nie in Chat/Logs

# Rolle im Pool: anlegen/konfigurieren/klonen/Snapshot/Energie
pveum role add XaventraOperator -privs "VM.Audit VM.PowerMgmt VM.Snapshot VM.Snapshot.Rollback VM.Allocate VM.Clone VM.Config.CPU VM.Config.Memory VM.Config.Disk VM.Config.CDROM VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.Config.HWType VM.Console VM.GuestAgent.Audit Pool.Audit"
# Speicher nur für eigene Disks (local-lvm) und Images lesen (local)
pveum role add XaventraStorage -privs "Datastore.AllocateSpace Datastore.Audit"

# ACLs — wegen privsep=1 für Token UND Benutzer (wirksam ist die Schnittmenge)
for who in "--tokens xaventra@pve!agent" "--users xaventra@pve"; do
  pveum acl modify /                              $who --roles PVEAuditor
  pveum acl modify /pool/xaventra                 $who --roles XaventraOperator
  pveum acl modify /storage/local-lvm             $who --roles XaventraStorage
  pveum acl modify /storage/local                 $who --roles XaventraStorage
  pveum acl modify /sdn/zones/localnetwork/vmbr0  $who --roles PVESDNUser
done
```

Hinweis: Proxmox selbst würde mit `VM.Allocate` im Pool auch das Löschen beliebiger
Pool-Gäste erlauben und mit `VM.Snapshot` das Löschen von Snapshots. Xaventra
erlaubt Löschen nur für `xaventra-created`-Gäste ohne Schutz und löscht nie
Snapshots — diese Grenze liegt im Adapter, die Labor-VM schützt zusätzlich
`protection=1`.

### 2. Fingerprint ermitteln

Auf dem Host (bzw. `pveproxy-ssl.pem`, falls ein eigenes Zertifikat hinterlegt ist):

```bash
openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256
```

Oder in der Oberfläche: Knoten → System → Zertifikate. Der Wert
(`AA:BB:…`, 32 Bytes) kommt nach `infra.proxmox.fingerprint`. Xaventra vertraut
dem selbstsignierten Zertifikat **nur** bei exakt diesem Fingerprint; TLS-Prüfung
wird nie global abgeschaltet. Nach einer Zertifikatserneuerung verweigert Xaventra
die Verbindung, bis der neue Fingerprint eingetragen ist.

### 3. Config und Token

```json
"infra": { "proxmox": {
  "enabled": true,
  "url": "https://<host>:8006",
  "fingerprint": "AA:BB:…",
  "pool": "xaventra",
  "limits": { "ramGB": 64, "cores": 16, "diskGB": 1024, "hostRamReserveGB": 16 },
  "create": { "storage": "local-lvm", "image": "local:iso/noble-server-cloudimg-amd64.img",
              "ciuser": "nova", "cicustom": "user=local:snippets/xaventra-nova.yaml",
              "sshKeys": ["ssh-ed25519 AAAA… owner"] }
} }
```

Token nur als Umgebungsvariable (nie in die Config, nie ins Log):
`XAVENTRA_PVE_TOKEN=xaventra@pve!agent=<secret>`. Das Format wird geprüft; bei
falschem Format meldet Xaventra den Fehler, ohne den Wert zu zeigen.

`watch` (Standard `true`) schaltet das Wahrnehmen (Gast gestartet/gestoppt,
Host-RAM ab `ramWarnPercent`, Deckel ≥ 90 %) — nur am Main, nur wenn
`autonomy.sensing.enabled` an ist. Die Gedanken laufen über den Gedanken-Hub.

Anlegen per `import-from=local:iso/…img` ist **ungeprüft**: verlangt Proxmox dafür
den Inhaltstyp `import`/`images`, das Image dorthin legen und `create.image`
anpassen — oder eine Vorlage im Pool anlegen und `/vms neu … vorlage <vmid>` nutzen.

## Befehle

`/vms` · `/vms meine` · `/vms snapshots <vmid>` · `/vms snapshot <vmid> [name]` ·
`/vms start|stop <vmid>` · `/vms rollback <vmid> <snap>` ·
`/vms neu <name> [kerne] [ramGB] [diskGB] [vorlage <vmid>]` · `/vms wegwerf <zweck>` ·
`/vms vergroessern <vmid> kerne=N ram=GB disk=GB` · `/vms entfernen <vmid>` ·
`/vms cloudinit` · `/vms hilfe`. Nur Owner; Worker erzeugen keine Karten.

## Rückweg

1. Aus: `infra.proxmox.enabled = false` (die Config wird bei jedem `/vms`-Aufruf und
   jeder Karte neu gelesen; das Wahrnehmen endet mit dem nächsten Neustart) und
   `XAVENTRA_PVE_TOKEN` aus der Umgebung entfernen (wirkt nach Neustart).
2. Auf dem Host Zugang entziehen (wirkt sofort):
   ```bash
   pveum user token remove xaventra@pve agent
   for p in / /pool/xaventra /storage/local-lvm /storage/local /sdn/zones/localnetwork/vmbr0; do
     pveum acl delete $p --users xaventra@pve --roles PVEAuditor,XaventraOperator,XaventraStorage,PVESDNUser 2>/dev/null
   done
   pveum user delete xaventra@pve
   pveum role delete XaventraOperator; pveum role delete XaventraStorage
   ```
3. Eigene VMs bleiben bestehen (Tag `xaventra-created`) und können in Proxmox von
   Hand entfernt werden; der Pool `xaventra` kann leer gelöscht werden.
