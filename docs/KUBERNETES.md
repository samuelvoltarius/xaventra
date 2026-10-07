# Kubernetes als Infrastruktur-Schicht (2.88)

**Grundsatz:** Kubernetes entscheidet, WO ein Prozess läuft. Xaventra entscheidet,
WAS ausgeführt wird — mit welchem Modell, welchem Werkzeug, welchen Daten — und
ob eine Freigabe nötig ist. Kubernetes ersetzt **nicht** das Xaventra-Mesh: Wer
Main ist, bestimmen allein Xaventras Lease, Witness-Epoche und Fencing.

Code: `deploy/helm/xaventra` (Chart), `src/infra/kubernetes-node.ts`
(In-Cluster-Erkennung, Label-Vorschläge), `src/infra/kubernetes.ts` (API-Adapter),
`src/infra/kubernetes-command.ts` (`/cluster`, Karten, Auto-Skalierung),
`src/mesh/mesh-policy.ts` (Workload-Peers für skalierbare Worker).

## Wann ist Kubernetes sinnvoll?

Sinnvoll, wenn schon ein Cluster läuft oder mehrere gleichartige Rechner in
**einem** Rechenzentrum/Netz stehen: Kubernetes verteilt dann Worker, startet
abgestürzte Pods neu, hält Ressourcen-Grenzen ein und erlaubt einen Namespace pro
Kunde (später Managed-Betrieb).

Nicht nötig für einen einzelnen Rechner oder ein paar Heimgeräte: dort ist die
normale Installation (nativ oder Docker) plus Xaventra-Mesh einfacher und
robuster.

## Topologie: Control Plane in EINER Zone

- Die **Control Plane** (API-Server, etcd) gehört in **eine** stabile Zone mit
  kurzer Latenz und verlässlichem Strom/Netz. etcd braucht ein Quorum; über WAN
  verteilte etcd-Mitglieder kippen bei jeder Leitungsstörung.
- **Heim- und WAN-Geräte** entweder als Worker-Nodes mit großzügigen Toleranzen
  (`wanTolerations: true` → `node.kubernetes.io/unreachable` und `not-ready`
  15 Minuten tolerieren, damit ein kurzer Leitungsausfall keine Pods vertreibt)
  **oder** — meist besser — als **direkte Mesh-Node** außerhalb des Clusters. Das
  Mesh ist für WAN gebaut (signierte Umschläge, Tailscale/TLS), Kubernetes nicht.
- **GPU-Einzelstücke** (eine große Karte, ein Spezialgerät) besser als direkte
  Mesh-Node betreiben: kein GPU-Operator, kein Treiber-Zirkus im Cluster, und
  Xaventra nutzt die Stärke trotzdem über das Mesh.

## Was das Chart anlegt

| Workload | Art | Standard | Zweck |
|---|---|---|---|
| `main` | StatefulSet | an, 1 aktive Instanz | Kanäle, Dashboard, API, Führung |
| `worker-general` | Deployment | an, 1–4 Replikas, automatisch | allgemeine Mesh-Arbeit |
| `voice` | Deployment | aus | Sprache (optional GPU) |
| `tool-sandbox` | Deployment | aus | Werkzeuge mit gesperrtem Ausgang |
| `browser-computer` | Deployment | aus | Desktop + Browser (eigenes Image nötig) |

- **Persistenz:** nur die Main hat PVCs — `state` (`/runtime`), `memory`
  (`/runtime/.nova-vector-memory`), `workspaces` (Git-Arbeitsbäume,
  `/runtime/.nova-data/mission-workspaces`). Worker sind zustandslos
  (emptyDir) und deshalb skalierbar.
- **Probes:** Start- und Lebend-Probe prüfen den Mesh-Listener über Loopback,
  die Bereit-Probe der Main ruft den bestehenden Endpunkt `GET /v1/health` der
  REST-API (bei `main.api.enabled=false` wieder den Mesh-Port).
- **Sicherheit:** kein root (`runAsUser 1000`), `seccompProfile: RuntimeDefault`,
  `allowPrivilegeEscalation: false`, alle Capabilities weg, nur-lesendes
  Root-Dateisystem (außer `browser-computer`), `/tmp` als emptyDir,
  `enableServiceLinks: false`.
- **Dienste:** `<name>-api` (Dashboard + API), `<name>-mesh` (Mesh-Einstieg),
  `<name>-main-headless` (feste DNS-Namen je Main-Pod, auch nicht-bereite).
  Ingress ist **aus**; eingeschaltet braucht er `ingress.host`
  (z. B. `xaventra.example.com`) und nur den *Namen* eines TLS-Secrets.
- **NetworkPolicies:** Mesh-Port der Main nur aus diesem Release (plus
  `networkPolicy.meshFrom`), API/Dashboard nur aus dem Release und
  `networkPolicy.apiFrom`, Worker nur von der Main, `tool-sandbox` darf nur DNS
  und den Mesh-Port der Main erreichen.
- **Ressourcen:** jede Workload hat Requests und Limits.

## Secrets: Kubernetes-Secret mit austauschbarem Backend

Das Chart erzeugt **kein** Secret und rendert keinen geheimen Wert. Es verweist
nur auf Secrets, die du anlegst:

- `secrets.existingSecret` — Umgebungsvariablen (`OPENAI_API_KEY`,
  `TELEGRAM_BOT_TOKEN`, `NOVA_API_TOKEN`, …), per `envFrom`.
- `config.existingSecret` — falls `xaventra.config.json` selbst Geheimes enthält.
  Sonst rendert das Chart `config.values` (nur Nicht-Geheimes) in eine ConfigMap.
- `workers.<x>.identitySecret` — der Mesh-Schlüssel einer Worker-Workload.

Woher das Secret kommt, ist austauschbar: von Hand angelegt, über den
**External Secrets Operator** (eine `ExternalSecret` mit demselben Zielnamen) oder
über **Vault** (Vault Secrets Operator bzw. Agent, der ein Kubernetes-Secret
schreibt). Das Chart muss dafür nicht geändert werden — beides bleibt eine
dokumentierte Option, nichts davon ist eingebaut.

## Installation in fünf Schritten

1. **Namespace und Umgebungs-Secret** anlegen (Werte gehören nie in Git):
   `kubectl create namespace xaventra` und
   `kubectl -n xaventra create secret generic xv-env --from-literal=NOVA_API_TOKEN=…`
2. **Worker-Schlüssel** (einmal je Worker-Workload, auf deinem Rechner):
   `NOVA_NODE_ID=xv-xaventra-worker-general npm run mesh:identity` gibt den
   öffentlichen Schlüssel aus und legt
   `.nova-data/mesh-identity/xv-xaventra-worker-general.json` an. Daraus das Secret:
   `kubectl -n xaventra create secret generic xv-worker-general-identity --from-file=identity.json=<diese Datei>`.
   Danach die Datei auf deinem Rechner löschen.
3. **Mesh-Vertrauen** in `config.values.mesh.direct.peers` eintragen
   (nur öffentliche Schlüssel):
   - für die Worker-Replikas **ein** Präfix-Eintrag:
     `{ "nodeIdPrefix": "xv-xaventra-worker-general-", "publicKey": "<öffentlicher Schlüssel aus Schritt 2>", "roles": ["system", "worker"] }`
   - für die Main als Peer der Worker:
     `{ "nodeId": "xv-xaventra-main-0", "url": "ws://xv-xaventra-main-0.xv-xaventra-main-headless.xaventra.svc.cluster.local:9091", "publicKey": "<Schlüssel der Main>", "roles": ["system", "worker"] }`.
     Den Schlüssel der Main erzeugt sie beim ersten Start selbst auf ihrem PVC;
     du liest ihn einmal aus (`node dist/mesh/mesh-identity-cli.js` im Main-Pod)
     und trägst ihn per `helm upgrade` nach.
4. **Installieren:**
   `helm install xv deploy/helm/xaventra -n xaventra --set secrets.existingSecret=xv-env --set workers.general.identitySecret=xv-worker-general-identity`
5. **Prüfen:** `/knoten` zeigt jeden Pod als „Kubernetes-Pod … in xaventra auf
   Knoten …“, `/cluster` zeigt Workloads, Pods und Warnungen.

Warum Präfix + ein Schlüssel? Deployment-Pods heißen jedes Mal anders
(`xv-xaventra-worker-general-<hash>-<hash>`). Jede Replika meldet sich unter ihrem
eigenen Pod-Namen, signiert aber mit dem Workload-Schlüssel. Die Main vertraut
genau einem Präfix mit genau einem festen Schlüssel — nie „trust on first use“,
nie Wildcards, dieselben Rollenregeln wie bei benannten Peers. Ein exakt
benannter Peer hat immer Vorrang. Verschwundene Replikas werden nach 24 h aus dem
Peer-Zustand gelöscht.

Im Cluster ist der Pod-Verkehr weder Tailscale noch TLS: Das Chart setzt deshalb
`mesh.direct.allowInsecureLan: true`. Umschläge bleiben signiert, die
NetworkPolicies begrenzen, wer verbinden darf, und Bildschirm-Mitschnitte
verlangen weiterhin einen verschlüsselten Weg. Ein CNI mit transparenter
Verschlüsselung ist empfohlen.

## Node-Labels

Konvention (nur `xaventra.ai/*`):

| Label | Werte | Bedeutung |
|---|---|---|
| `xaventra.ai/gpu` | `true`/`false` | GPU wird tatsächlich genutzt (Backend ≠ CPU oder vLLM) |
| `xaventra.ai/gpu-class` | `nvidia`, `amd`, `apple`, `intel`, `other`, `none` | GPU-Familie |
| `xaventra.ai/memory` | `small` (<8 GB), `medium` (<32), `large` (<128), `xlarge` | RAM-Klasse |
| `xaventra.ai/desktop` | `true`/`false` | Anzeige vorhanden |
| `xaventra.ai/browser` | `true`/`false` | Browser/Playwright vorhanden |
| `xaventra.ai/general` | `true`/`false` | taugt für allgemeine Arbeit |

Workloads nutzen sie über `placement.require` (harter `nodeSelector`) und
`placement.prefer` (weiche Node-Affinität). Standard ist weich, damit ein Cluster
ohne Labels trotzdem startet; nur `browser-computer` verlangt
`xaventra.ai/desktop=true`.

`/cluster labels` erzeugt aus den Knotenprofilen (eigenes + Mesh-Peers)
**Vorschläge**. Xaventra setzt keine Labels: `kubectl` bleibt auf der Nie-Liste
(`src/install/never-list.ts`), Labels setzt der Owner selbst.

## Steuerung durch Xaventra (`/cluster`)

Xaventra steuert ihr **eigenes** Release über einen engen Adapter — direkt gegen
die Kubernetes-API mit dem ServiceAccount der Main (außerhalb des Clusters: eigenes
Konto über `infra.kubernetes.server`, `infra.kubernetes.caFile` und
`XAVENTRA_K8S_TOKEN_FILE`; keine kubeconfig-Exec-Plugins). Nie rohes kubectl.

| Aktion | Karte | Hinweis |
|---|---|---|
| Status, Events, Logs lesen | nein | Logs begrenzt und geschwärzt |
| eigenen Worker skalieren | nein | nur innerhalb `replicas.min`–`replicas.max` |
| eigenen Worker neu starten | nein | Rollout-Restart |
| Main oder optionale Workload neu starten | **ja** | |
| Chart-Update (`image.tag`, `<w>.min/max`, `<w>.resources…`) | **ja** | Vorschau alt → neu; vor dem Anwenden liest Xaventra den Cluster neu und bricht ab, wenn er sich geändert hat |
| Workload abschalten (`/cluster abschalten <w>`) | **ja** | Karte zeigt „ENTFERNT“; Daten-PVCs bleiben |

Nie (kein Codepfad): fremde Namespaces und cluster-weite Objekte, Secrets lesen
oder ändern, Tokens anfordern, `pods/exec|attach|portforward|proxy`, PVCs,
Namespaces oder Daten löschen, die Main über Kubernetes skalieren. Jede Anfrage
läuft vor dem Senden durch einen Wächter (`checkKubeRequest`); abgelehnte
Anfragen erreichen den API-Server nie. Jede schreibende Aktion verlangt die
Main-Lease (Fencing).

Die **Role** (nur im eigenen Namespace, keine ClusterRole) erlaubt genau das:
lesen von Pods, Logs, Events, Deployments, StatefulSets, ReplicaSets, Leases;
`get/patch` auf die eigenen Worker-Deployments und deren `scale`; `patch` auf das
Main-StatefulSet; `get/patch` auf die eigene Steuer-ConfigMap. Kein `secrets`,
kein `pods/exec`, kein `create`/`delete`. Worker bekommen keinen API-Token.

**Auto-Skalierung:** viele offene Aufgaben → mehr Worker (`tasksPerWorker`),
Leerlauf (`idleMinutes`) → eine Replika weniger; immer innerhalb der Grenzen und
mit Abkühlzeit (`cooldownSeconds`). Nur die Lease-haltende Main skaliert.
Autoskalierte Deployments haben kein `replicas`-Feld, damit ein `helm upgrade`
nicht dagegen arbeitet.

Hinweis: Werte, die Xaventra per Karte ändert, stehen danach im Cluster und in
der Steuer-ConfigMap (`applied`). Ein späteres `helm upgrade` ohne diese Werte
setzt sie zurück — übernimm sie in deine values-Datei.

## Main, warme Kandidaten und Führung

`main.warmCandidates` startet zusätzliche Main-Pods. Sie führen **nur** über
Xaventras eigene Lease/Witness-Epoche/Fencing; das Chart verweigert warme
Kandidaten ohne `main.leaseCoordinator: witness` oder `supabase`. Eine
Kubernetes-Lease wird für die Führung nicht verwendet (höchstens ein späteres
Zusatzsignal). Ob ein Release überhaupt Main werden darf, entscheidet der Owner
(`main.mainEligible`). Worker sind nie Main-fähig.

## In-Cluster-Erkennung

Läuft Xaventra in einem Pod (`KUBERNETES_SERVICE_HOST`), meldet das Knotenprofil
Pod, Namespace, Kubernetes-Node, Workload und Rolle (Downward API:
`XAVENTRA_POD_NAME`, `XAVENTRA_POD_NAMESPACE`, `XAVENTRA_K8S_NODE_NAME`,
`XAVENTRA_K8S_WORKLOAD`, `XAVENTRA_K8S_RELEASE`). Laufzeit ist dann „Container“
(auch bei containerd mit cgroup v2), Installationsweg „neues Image“. Keine
Annahmen über SSH oder systemd; Mesh-Beitritt über den Service.

## Mandanten (später Managed)

Ein Release pro Kunden-Namespace (`helm install kunde-a … -n kunde-a`) mit
`tenant.enabled=true`:

- **ResourceQuota** (CPU, RAM, Speicher, PVCs, Pods; keine LoadBalancer/NodePorts),
- **LimitRange** (Standard- und Höchstwerte je Container),
- **NetworkPolicy** „default deny“ für jeden Pod im Namespace — nur die
  Release-Policies öffnen einzelne Ports, nichts aus anderen Namespaces kommt rein,
- optional `tenant.createNamespace=true`: Namespace mit Pod Security
  „restricted“ und Label `xaventra.ai/tenant`.

## Bewusst offen / später

- **Proxmox-VM automatisch als Kubernetes-Node** registrieren: braucht ein
  Join-Token (ein Secret) und ist deshalb nicht Teil dieses Pakets. Späterer
  Schritt: eigene VM per Karte anlegen (`/vms neu`), Join macht der Owner.
- Mit warmen Main-Kandidaten verteilt der Dienst `<name>-api` Anfragen auf alle
  Main-Pods; nur der Lease-Halter bedient Dashboard/API.
- `browser-computer` braucht ein eigenes Image mit Anzeige-Server und Browser.

## Tests

Ohne `helm` rendert `test/helpers/helm-lite.ts` das Chart; `src/infra/helm-chart.test.ts`
prüft Struktur, Sicherheit, RBAC, NetworkPolicies und dass kein Secret im Klartext
steht. Ist `helm` installiert (CI), laufen zusätzlich `helm lint` und
`helm template`. Adapter und Karten testen gegen einen gemockten API-Server
(`test/helpers/fake-kube.ts`), inklusive Gegenproben (fremder Namespace,
Secret-Zugriff, exec → abgelehnt ohne Request).
