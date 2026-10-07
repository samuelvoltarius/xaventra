# Kubernetes als Infrastruktur-Schicht (2.88, Worker-Chart 2.89)

**Grundsatz:** Kubernetes entscheidet, WO ein Prozess läuft. Xaventra entscheidet,
WAS ausgeführt wird — mit welchem Modell, welchem Werkzeug, welchen Daten — und
ob eine Freigabe nötig ist. Kubernetes ersetzt **nicht** das Xaventra-Mesh: Wer
Main ist, bestimmen allein Xaventras Lease, Witness-Epoche und Fencing.

Code: `deploy/helm/xaventra` (Chart), `src/infra/kubernetes-node.ts`
(In-Cluster-Erkennung, Label-Vorschläge), `src/infra/kubernetes.ts` (API-Adapter),
`src/infra/kubernetes-command.ts` (`/cluster`, Karten),
`src/mesh/mesh-policy.ts` (Workload-Peers mit Präfix-Vertrauen).

## Wann ist Kubernetes sinnvoll?

Sinnvoll, wenn schon ein Cluster läuft oder mehrere gleichartige Rechner Worker
tragen sollen: Kubernetes startet abgestürzte Pods neu, hält Ressourcen-Grenzen
ein, rollt neue Versionen Knoten für Knoten aus und erlaubt einen Namespace pro
Kunde (später Managed-Betrieb).

Nicht nötig für einen einzelnen Rechner oder ein paar Heimgeräte: dort ist die
normale Installation (nativ oder Docker) plus Xaventra-Mesh einfacher und
robuster. Bestehende Docker-Worker bleiben Docker-Worker, solange niemand sie
bewusst umstellt.

## Feste Regeln

1. **Kubernetes nie direkt auf Hosts**, die schon Docker- oder VM-Netze tragen
   (Bare-Metal-Server mit Docker-Diensten, Hypervisor). Kubernetes-Knoten sind
   **eigene VMs**. Grund: Kubernetes schaltet die Brücken-Filter
   (`br_netfilter`) ein; das kann bestehende Docker-Brücken und VM-Netze
   stören. Ein Rückweg entlädt nie Kernel- oder Netzmodule.
2. **Die Main bleibt außerhalb** (nativ, z. B. auf dem GPU-Rechner). Das Chart
   rendert standardmäßig **keine** Main (`main.enabled: false`); die Worker
   verbinden sich von sich aus zur externen Main.
3. **Worker = DaemonSet**, nie Deployment: höchstens ein Pod je Knoten, stabile
   Mesh-Identität und eigenes `/runtime` je Knoten.
4. **Nur freigegebene Knoten:** ein Worker-Pod startet nur auf Knoten mit
   `xaventra.ai/worker=true`. Das Label setzt der Owner selbst, Knoten für
   Knoten — Xaventra setzt nie Labels.
5. **Kein `hostNetwork`.** Läuft auf einem Knoten noch ein Docker-Worker mit
   Host-Netz, wäre ein zusätzlicher Pod dort ein **Split-Brain** im Mesh.
   Darum: erst Docker-Worker abschalten, dann Label setzen (siehe unten).
6. **Sandbox-Workloads** (Werkzeug-Sandbox, Forge, Code-Ausführung, fremde
   MCP-Server) laufen nur mit der RuntimeClass **`kata-clh`** (Kata Containers
   mit Cloud Hypervisor). Ohne sie verweigert das Chart die Installation.
7. **Secrets** (Umgebung, Koordinations-CA, Mesh-Schlüssel, Steuer-Token) nur als
   Referenz auf Kubernetes-Secrets, angelegt **per Pipe**, nie angezeigt, nie
   als Datei im Repo.

## Topologie: Control Plane in EINER Zone

- Die **Control Plane** (API-Server, etcd) gehört in **eine** stabile Zone mit
  kurzer Latenz und verlässlichem Strom/Netz. etcd braucht ein Quorum; über WAN
  verteilte etcd-Mitglieder kippen bei jeder Leitungsstörung.
- **Heim- und WAN-Knoten** als Worker-VMs mit Taint
  `xaventra.ai/wan=true:PreferNoSchedule` und großzügigen Toleranzen (siehe
  unten) **oder** — für Einzelgeräte oft besser — als **direkte Mesh-Node**
  außerhalb des Clusters. Das Mesh ist für WAN gebaut (signierte Umschläge,
  Tailscale/TLS), Kubernetes nicht.
- **GPU-Einzelstücke** besser als direkte Mesh-Node betreiben: kein
  GPU-Operator, kein Treiber-Zirkus im Cluster, und Xaventra nutzt die Stärke
  trotzdem über das Mesh.

## Was das Chart anlegt

| Workload | Art | Standard | Zweck |
|---|---|---|---|
| `worker-general` | DaemonSet | an | allgemeine Mesh-Arbeit, ein Pod je freigegebenem Knoten |
| `voice` | DaemonSet | aus | Sprache (Knoten zusätzlich mit `xaventra.ai/gpu=true`) |
| `tool-sandbox` | DaemonSet | aus | Sandbox-Workload, nur mit `kata-clh` |
| `browser-computer` | DaemonSet | aus | Desktop + Browser (eigenes Image nötig, Knoten mit `xaventra.ai/desktop=true`) |
| `main` | StatefulSet | **aus** | nur auf ausdrücklichen Wunsch, mit eigener vollständiger Konfiguration |

Dazu: ServiceAccount `<name>-worker` (ohne API-Token), ServiceAccount + Role +
RoleBinding `<name>-control` (Steuer-Konto), ConfigMaps `<name>-config`
(Worker-Konfiguration ohne Geheimnisse) und `<name>-control` (Steuer-Regeln),
NetworkPolicy `<name>-workers`. Keine Services, kein Ingress, keine PVCs, solange
keine Main im Cluster läuft.

### Platzierung

- `nodeSelector`: `xaventra.ai/worker: "true"` (fest, nicht abschaltbar) plus
  Zusatz-Labels je Workload (`workers.<w>.require`).
- Harte Ausschluss-Affinität: nie auf Knoten mit `xaventra.ai/docker-worker`
  (Wert egal). Damit markiert der Owner Knoten, auf denen noch ein Docker-Worker
  läuft — doppelter Schutz neben dem fehlenden Freigabe-Label.
- Rollout: `RollingUpdate` mit `maxUnavailable: 1`, **`maxSurge: 0`** — nie zwei
  Pods derselben Identität gleichzeitig auf einem Knoten.

### Toleranzen

Jeder Worker toleriert `xaventra.ai/wan` (PreferNoSchedule) sowie
`node.kubernetes.io/unreachable` und `not-ready` (NoExecute) für 900 Sekunden.
Ehrlicher Hinweis: Für DaemonSet-Pods setzt der Kubernetes-DaemonSet-Controller
diese beiden NoExecute-Toleranzen selbst **ohne** Frist — ein DaemonSet-Pod wird
bei Leitungsausfall also gar nicht vertrieben (er würde ohnehin nicht auf einen
anderen Knoten wandern). Die 900 s im Chart sind die dokumentierte Absicht; was
tatsächlich gilt, zeigt `kubectl get pod … -o jsonpath='{.spec.tolerations}'`.

### Identität und `/runtime` je Knoten

- Mesh-ID: `NOVA_NODE_ID = <nodeIdPrefix>-<Knotenname>` (aus `spec.nodeName`
  über die Downward-API). Standard-Präfix `<release-name>-<workload>`. Knotennamen
  müssen DNS-Labels sein (keine Punkte).
- Schlüssel: entweder ein Workload-Schlüssel als Secret (`workers.<w>.identitySecret`,
  `identity.json` mit `nodeId` = Präfix; die Main vertraut genau **einem**
  `nodeIdPrefix`-Eintrag mit festem öffentlichem Schlüssel), oder ohne Secret: jeder
  Knoten erzeugt beim ersten Start seinen eigenen Schlüssel im eigenen `/runtime`
  und der Owner trägt jeden öffentlichen Schlüssel an der Main ein.
- `/runtime`: **hostPath** unter dem festen Verzeichnis `/var/lib/xaventra/`
  (`workers.<w>.runtimeHostPath`, Typ `Directory` — muss existieren, Besitzer
  1000:1000, Rechte 0700; das Chart legt es nie an). Das Chart verweigert Pfade
  außerhalb von `/var/lib/xaventra/`, Pfade mit `..` und zwei Workloads mit
  demselben Pfad.
- **Warum hostPath und nicht local-path-PVC?** Ein DaemonSet hat keine
  `volumeClaimTemplates`: alle Pods teilen sich denselben `claimName`. Ein
  local-path-Volume ist an **einen** Knoten gebunden — Pods auf anderen Knoten
  könnten es nie einbinden. Ein PVC je Knoten müsste von Hand angelegt und
  zugeordnet werden und widerspräche „ein Template für alle Knoten“. hostPath
  unter einem festen Xaventra-Pfad gibt jedem Knoten genau sein eigenes
  `/runtime`, überlebt Pod-Neustarts und Chart-Updates und passt zur
  Docker-Worker-Migration (Snapshot nach `/var/lib/xaventra/runtime`). Preis:
  Pod Security „baseline/restricted“ verbietet hostPath — der Namespace darf
  diese Stufen nicht erzwingen (alles andere im Chart erfüllt „restricted“).

### Split-Brain-Schutz

1. Ohne `xaventra.ai/worker=true` startet nirgends ein Pod.
2. `xaventra.ai/docker-worker` schließt einen Knoten hart aus.
3. **Startprüfung** (Init-Container `host-port-guard`, ohne hostNetwork): Vor dem
   Start versucht der Pod, die Ports 9091 (Mesh) und 18789 (REST) auf der
   **eigenen Knoten-Adresse** (`status.hostIP`) zu erreichen. Antwortet dort
   etwas — typischerweise ein alter Docker-Worker mit Host-Netz —, bricht der
   Start mit klarer Meldung ab. Grenze: Ein Dienst, der nur an `127.0.0.1` des
   Knotens lauscht, ist aus dem Pod nicht sichtbar. Darum bleiben Label und
   Reihenfolge (erst Docker aus, dann Label) der Hauptschutz.

### Probes

- Start und Lebend: TCP auf den Mesh-Listener über Loopback.
- Bereit: wie beim Docker-Worker-Tausch — authentifiziertes
  `GET /v1/status` auf `127.0.0.1:18789` (Token aus dem Umgebungs-Secret, bleibt
  im Container); die gemeldete Version muss `XAVENTRA_EXPECTED_VERSION`
  entsprechen (Image-Tag bzw. `image.version`; bei Digest ohne `image.version`
  kein Versionsvergleich). Alternative `workers.<w>.readiness: mesh`.

### Sicherheit

Kein root (`runAsUser 1000`), `seccompProfile: RuntimeDefault`,
`allowPrivilegeEscalation: false`, alle Capabilities weg, nur-lesendes
Root-Dateisystem (außer `browser-computer`), `/tmp` als emptyDir,
`enableServiceLinks: false`, kein API-Token für Worker, kein hostNetwork, kein
hostPID/hostIPC, keine hostPorts. NetworkPolicy: **niemand** verbindet sich zu
Worker-Pods (die Worker wählen selbst die Main an und antworten über diese
Verbindung). Sandbox-Workloads: Ausgang nur DNS plus
`networkPolicy.sandboxEgressTo`.

## Verbindung zur externen Main

Die Worker brauchen nur ausgehende Verbindungen: zur Main über ihre
Tailscale-Adresse bzw. `wss://` und zum Koordinationsdienst. Pod-Verkehr nach
außen läuft über den Knoten (NAT); die Gegenseite sieht die Knoten-Adresse.

- `externalMain.nodeId`, `externalMain.url` (`wss://…` allgemein; `ws://` nur mit
  Tailscale-IP (Bereich 100.64/10, `ws://<Tailscale-IP>:9091`) — Hostnamen und
  andere Adressen werden abgelehnt) und `externalMain.publicKey` (nur der **öffentliche** Schlüssel)
  ergänzen die Worker-Konfiguration um genau einen festen Peer. Diese Werte sind
  Topologie und gehören in eine **private** values-Datei.
- Die Main muss den Workern vertrauen: ein `nodeIdPrefix`-Eintrag (mit
  Workload-Schlüssel) oder je Knoten ein benannter Peer.
- `coordinationCA.existingSecret`: Secret mit der CA des Koordinationsdienstes
  (Schlüssel `ca.crt`), eingebunden unter `/run/secrets/coordination-ca.crt` wie
  bei den Docker-Workern; das Chart setzt `NODE_EXTRA_CA_CERTS` darauf.
- `config.fromRuntime: true` nutzt die `xaventra.config.json`, die nach einer
  Migration schon im `/runtime` liegt. Vorher `mesh.direct.listenHost` prüfen: eine
  Tailscale-Adresse des Hosts gibt es im Pod nicht (`0.0.0.0` verwenden).

## Secrets per Pipe (nie anzeigen)

Das Chart erzeugt **kein** Secret und rendert keinen geheimen Wert. Angelegt wird
jedes Secret per Pipe, sodass der Inhalt nie auf dem Bildschirm, in einer Datei
oder im Verlauf landet:

- Umgebung (`secrets.existingSecret`), z. B. aus einem laufenden Docker-Worker:
  `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <container> | grep -vE '^(PATH|NODE_VERSION|YARN_VERSION|HOME|NOVA_NODE_ID)=' | kubectl -n xaventra create secret generic xaventra-worker-env --from-env-file=/dev/stdin`
- Koordinations-CA: `cat <ca-datei> | kubectl -n xaventra create secret generic xaventra-coordination-ca --from-file=ca.crt=/dev/stdin`
- Workload-Schlüssel: `NOVA_NODE_ID=<präfix> npm run mesh:identity` auf deinem
  Rechner, dann `kubectl -n xaventra create secret generic <name> --from-file=identity.json=<datei>`
  und die Datei löschen.

Woher ein Secret kommt, ist austauschbar: von Hand, über den **External Secrets
Operator** (eine `ExternalSecret` mit demselben Zielnamen) oder über **Vault**
(Vault Secrets Operator bzw. Agent). Das Chart muss dafür nicht geändert werden.

## Steuerung durch Xaventra (`/cluster`)

Xaventra steuert ihr **eigenes** Release über einen engen Adapter — direkt gegen
die Kubernetes-API, nie mit rohem kubectl. Konto ist der ServiceAccount
`<name>-control`:

- **Externe Main (Normalfall):** in ihrer Konfiguration
  `infra.kubernetes = { server, caFile, namespace, release }`, Token-Datei über
  `XAVENTRA_K8S_TOKEN_FILE`. Das Token entsteht per Pipe und ist befristet:
  `kubectl -n xaventra create token xaventra-control --duration=720h | ssh <main> 'umask 077; cat > <token-datei>'`
  (vor Ablauf erneuern). Die CA-Datei ist das öffentliche Cluster-Zertifikat. Die
  Steuer-Regeln liest die Main über die API aus der ConfigMap `<name>-control`
  (nur `get` auf genau dieses Objekt).
- **Main im Cluster (optional):** der Pod bindet das Konto und die Steuerdatei ein.

| Aktion | Karte | Hinweis |
|---|---|---|
| Status, Events, Logs lesen | nein | Logs begrenzt und geschwärzt |
| eigenen Worker neu starten | nein | Rollout-Restart des eigenen DaemonSets, Knoten für Knoten |
| Main oder optionale Workload neu starten | **ja** | |
| Chart-Update (`image.tag`, `<w>.resources…`) | **ja** | Vorschau alt → neu; vor dem Anwenden liest Xaventra den Cluster neu und bricht ab, wenn er sich geändert hat |
| skalieren / abschalten | — | gibt es nicht: `/cluster skalieren` und `/cluster abschalten` erklären nur, dass der Owner Knoten-Labels bzw. `helm` nutzt |

**Keine Auto-Skalierung.** Worker sind DaemonSets: ein Pod je freigegebenem
Knoten, es gibt keine Replikazahl. Die frühere Auto-Skalierung (Deployments
nach offenen Aufgaben) ist entfernt. Mehr Rechenkraft heißt: einen weiteren
Knoten freigeben — eine bewusste Entscheidung des Owners, keine automatische.

Nie (kein Codepfad): fremde Namespaces und cluster-weite Objekte (auch keine
Knoten-Labels), Secrets lesen oder ändern, Tokens anfordern,
`pods/exec|attach|portforward|proxy`, PVCs, `scale`, Namespaces oder Daten
löschen, die Main über Kubernetes skalieren. Jede Anfrage läuft vor dem Senden
durch einen Wächter (`checkKubeRequest`); abgelehnte Anfragen erreichen den
API-Server nie. Jede schreibende Aktion verlangt die Main-Lease (Fencing).

Die **Role** (nur im eigenen Namespace, keine ClusterRole) erlaubt genau das:
lesen von Pods, Logs, Events, DaemonSets, StatefulSets; `patch` auf die eigenen
Worker-DaemonSets (per `resourceNames`, nie leer); `patch` auf das
Main-StatefulSet nur mit `main.enabled`; `get` auf die eigene Steuer-ConfigMap.
Kein `secrets`, kein `pods/exec|attach|portforward`, kein `create`/`delete`,
kein `scale`.

## Sandbox mit `kata-clh`

`workers.toolSandbox` (und jede Workload mit `sandbox: true`) bekommt
`runtimeClassName: kata-clh`. Solange `sandbox.runtimeClassActive` nicht `true`
ist, bricht `helm install/upgrade/template` mit einer klaren Meldung ab. Erst
Kata Containers im Cluster einrichten (eigene Entscheidung, versioniert über
kata-deploy), RuntimeClass prüfen, dann den Schalter setzen. Andere Laufzeiten
sind für Sandbox-Workloads nicht freigegeben.

## Pilot und Migration eines Docker-Workers

Reihenfolge je Knoten — nie Docker und Pod gleichzeitig:

1. Knoten mit laufendem Docker-Worker vorsorglich markieren:
   `kubectl label node <knoten> xaventra.ai/docker-worker=true`.
2. Pilot zuerst auf einem **neuen** Knoten ohne Docker-Worker.
3. Migration später: `/runtime` per Snapshot nach `/var/lib/xaventra/runtime`
   kopieren (nie das Live-Verzeichnis), Docker-Worker stoppen (Container bleibt
   liegen = Rückweg), `xaventra.ai/docker-worker` entfernen, dann
   `xaventra.ai/worker=true` setzen und zurücklesen.

**Rückweg** (unter 2 Minuten je Knoten): `kubectl label node <knoten> xaventra.ai/worker-`
→ der Pod verschwindet; Docker-Worker wieder starten. Ganz zurück:
`helm uninstall` (entfernt alle Chart-Objekte; die hostPath-Verzeichnisse und
von Hand angelegte Secrets bleiben, bis der Owner sie selbst entfernt). Ein
Rückweg fasst nie Kernel- oder Netzmodule an.

## Node-Labels

Konvention (nur `xaventra.ai/*`):

| Label | Werte | Bedeutung |
|---|---|---|
| `xaventra.ai/worker` | `true` | Owner-Freigabe: hier darf ein Worker-Pod laufen |
| `xaventra.ai/docker-worker` | beliebig | hier läuft noch ein Docker-Worker — nie ein Pod |
| `xaventra.ai/gpu` | `true`/`false` | GPU wird tatsächlich genutzt (Backend ≠ CPU oder vLLM) |
| `xaventra.ai/gpu-class` | `nvidia`, `amd`, `apple`, `intel`, `other`, `none` | GPU-Familie |
| `xaventra.ai/memory` | `small` (<8 GB), `medium` (<32), `large` (<128), `xlarge` | RAM-Klasse |
| `xaventra.ai/desktop` | `true`/`false` | Anzeige vorhanden |
| `xaventra.ai/browser` | `true`/`false` | Browser/Playwright vorhanden |
| `xaventra.ai/general` | `true`/`false` | taugt für allgemeine Arbeit |

`/cluster labels` erzeugt aus den Knotenprofilen **Vorschläge**. Xaventra setzt
keine Labels: `kubectl` bleibt auf der Nie-Liste (`src/install/never-list.ts`).

## Main im Cluster (optional) und Führung

`main.enabled: true` rendert eine Main als StatefulSet (mit PVCs für Zustand,
Gedächtnis und Arbeitsbäume, Diensten und NetworkPolicy) und verlangt eine
vollständige eigene Konfiguration (`config.existingSecret` oder
`config.existingConfigMap`). `main.warmCandidates` startet zusätzliche
Main-Pods; sie führen **nur** über Xaventras eigene Lease/Witness-Epoche/Fencing —
das Chart verweigert warme Kandidaten ohne `main.leaseCoordinator: witness` oder
`supabase`. Worker sind nie Main-fähig.

## In-Cluster-Erkennung

Läuft Xaventra in einem Pod (`KUBERNETES_SERVICE_HOST`), meldet das Knotenprofil
Pod, Namespace, Kubernetes-Knoten, Workload und Rolle (Downward API:
`XAVENTRA_POD_NAME`, `XAVENTRA_POD_NAMESPACE`, `XAVENTRA_K8S_NODE_NAME`,
`XAVENTRA_K8S_WORKLOAD`, `XAVENTRA_K8S_RELEASE`).

## Mandanten (später Managed)

Ein Release pro Kunden-Namespace (`helm install kunde-a … -n kunde-a`) mit
`tenant.enabled=true`:

- **ResourceQuota** (CPU, RAM, Speicher, PVCs, Pods; keine LoadBalancer/NodePorts),
- **LimitRange** (Standard- und Höchstwerte je Container),
- **NetworkPolicy** „default deny“ für jeden Pod im Namespace,
- optional `tenant.createNamespace=true`: Namespace mit Label
  `xaventra.ai/tenant`, Pod Security `enforce: privileged` (nur wegen des
  hostPath-`/runtime`) und `audit: restricted`.

## Bewusst offen / später

- **Proxmox-VM automatisch als Kubernetes-Knoten**: braucht ein Join-Token (ein
  Secret) und ist eigenes Paket (VM per Karte vorschlagen, Owner-Ja, Beitritt
  über einen Secret-Broker).
- Kata Containers (`kata-clh`) einrichten — eigene Entscheidung.
- `browser-computer` braucht ein eigenes Image mit Anzeige-Server und Browser.

## Tests

Ohne `helm` rendert `test/helpers/helm-lite.ts` das Chart; `src/infra/helm-chart.test.ts`
prüft DaemonSet, Freigabe-Label, Ausschluss-Label, kein hostNetwork, Toleranzen,
Identität und `/runtime` je Knoten, die Startprüfung (auch das Skript selbst),
Sandbox nur mit `kata-clh`, keine Main per Standard, RBAC ohne
secrets/exec/attach/portforward und dass weder Geheimnisse noch private Adressen
im Chart stehen. Ist `helm` installiert (CI), laufen zusätzlich `helm lint` und
`helm template`. Adapter und `/cluster` testen gegen einen gemockten API-Server
(`test/helpers/fake-kube.ts`), inklusive Gegenproben (fremder Namespace,
Secret-Zugriff, exec, Knoten-Labels, scale → abgelehnt ohne Request).
