{{/*
Xaventra chart helpers. Kept to a small, plain subset of Helm templating so
the structural tests can render the chart without the helm binary.
*/}}

{{- define "xaventra.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "xaventra.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 40 | trimSuffix "-" -}}
{{- else if contains (include "xaventra.name" .) .Release.Name -}}
{{- .Release.Name | trunc 40 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "xaventra.name" .) | trunc 40 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "xaventra.labels" -}}
app.kubernetes.io/name: {{ include "xaventra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "xaventra.selectorLabels" -}}
app.kubernetes.io/name: {{ include "xaventra.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* Image of the root chart or a workload override: dict "root" $ "image" <map> */}}
{{- define "xaventra.image" -}}
{{- $img := .root.Values.image -}}
{{- $repo := default $img.repository .image.repository -}}
{{- $digest := default $img.digest .image.digest -}}
{{- if $digest -}}
{{- printf "%s@%s" $repo $digest -}}
{{- else -}}
{{- printf "%s:%s" $repo (default (default .root.Chart.AppVersion $img.tag) .image.tag) -}}
{{- end -}}
{{- end -}}

{{/* Version the readiness probe expects (empty = no comparison): dict "root" $ "image" <map> */}}
{{- define "xaventra.expectedVersion" -}}
{{- $img := .root.Values.image -}}
{{- if $img.version -}}
{{- $img.version -}}
{{- else if not (default $img.digest .image.digest) -}}
{{- default (default .root.Chart.AppVersion $img.tag) .image.tag -}}
{{- end -}}
{{- end -}}

{{/* Downward API + chart facts for the in-cluster detection. Pod/node first:
     NOVA_NODE_ID may reference them with $(...).
     dict "root" $ "workload" <name> "nodeId" <value with $(VARS)> */}}
{{- define "xaventra.podEnv" -}}
- name: XAVENTRA_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: XAVENTRA_POD_NAMESPACE
  valueFrom:
    fieldRef:
      fieldPath: metadata.namespace
- name: XAVENTRA_K8S_NODE_NAME
  valueFrom:
    fieldRef:
      fieldPath: spec.nodeName
- name: NOVA_NODE_ID
  value: {{ .nodeId | quote }}
- name: XAVENTRA_K8S_WORKLOAD
  value: {{ .workload | quote }}
- name: XAVENTRA_K8S_RELEASE
  value: {{ .root.Release.Name | quote }}
- name: NODE_ENV
  value: "production"
- name: HOME
  value: "/runtime/.home"
- name: NOVA_MESH_DIRECT_PORT
  value: {{ .root.Values.mesh.directPort | quote }}
- name: NOVA_FENCING_MODE
  value: {{ .root.Values.mesh.fencingMode | quote }}
{{- end -}}

{{/* Loopback TCP check (liveness/readiness), independent of the bind address. Arg: port */}}
{{- define "xaventra.tcpProbe" -}}
exec:
  command:
    - node
    - -e
    - {{ printf "require('net').connect(%v,'127.0.0.1').on('connect',function(){process.exit(0)}).on('error',function(){process.exit(1)})" . | quote }}
{{- end -}}

{{/* Existing REST health endpoint GET /v1/health on loopback. Arg: port */}}
{{- define "xaventra.restHealthProbe" -}}
exec:
  command:
    - node
    - -e
    - {{ printf "fetch('http://127.0.0.1:%v/v1/health').then(function(r){process.exit(r.ok?0:1)},function(){process.exit(1)})" . | quote }}
{{- end -}}

{{/* Worker readiness like the Docker worker swap: authenticated GET /v1/status on
     loopback, version must equal XAVENTRA_EXPECTED_VERSION when that is set.
     The token stays inside the container (env from the Secret). Arg: port */}}
{{- define "xaventra.statusProbe" -}}
exec:
  command:
    - node
    - -e
    - {{ printf "var t=process.env.NOVA_API_TOKEN,v=process.env.XAVENTRA_EXPECTED_VERSION;fetch('http://127.0.0.1:%v/v1/status',{headers:t?{Authorization:'Bearer '+t}:{},signal:AbortSignal.timeout(6000)}).then(function(r){return r.ok?r.json():Promise.reject(r.status)}).then(function(j){process.exit(!v||(j&&j.version===v)?0:1)},function(){process.exit(1)})" . | quote }}
{{- end -}}

{{/* Split-brain guard: fails when one of the ports answers on the node's own
     address (status.hostIP) — e.g. an old Docker worker with host network.
     It cannot see listeners bound only to the host's loopback; the node labels
     stay the main protection (docs/KUBERNETES.md). */}}
{{- define "xaventra.hostPortGuardScript" -}}
var net=require('net'),h=process.env.XAVENTRA_HOST_IP,ports=String(process.env.XAVENTRA_GUARD_PORTS||'').split(',').filter(Boolean).map(Number),busy=[],left=ports.length;function fin(){if(--left>0)return;if(busy.length){console.error('Xaventra: Port '+busy.join(',')+' auf diesem Knoten ist belegt - laeuft hier noch ein Docker-Worker? Start verweigert (Split-Brain-Schutz). Erst den Docker-Worker stoppen, dann neu starten.');process.exit(1)}console.log('Xaventra: Knoten frei ('+ports.join(',')+')');process.exit(0)}if(!h||!left){console.error('Xaventra: Knoten-Adresse oder Ports fehlen - Start verweigert');process.exit(1)}ports.forEach(function(p){var done=false,s=net.connect({host:h,port:p});function end(b){if(done)return;done=true;if(b)busy.push(p);s.destroy();fin()}s.setTimeout(2000,function(){end(false)});s.on('connect',function(){end(true)});s.on('error',function(){end(false)})})
{{- end -}}

{{/* Node placement for the optional in-cluster Main:
     dict "placement" <map> "affinity" <map> "tolerations" <list> "wan" <bool> */}}
{{- define "xaventra.placement" -}}
{{- if .placement.require }}
nodeSelector:
  {{- toYaml .placement.require | nindent 2 }}
{{- end }}
{{- if .affinity }}
affinity:
  {{- toYaml .affinity | nindent 2 }}
{{- else if .placement.prefer }}
affinity:
  nodeAffinity:
    preferredDuringSchedulingIgnoredDuringExecution:
      {{- range $key, $value := .placement.prefer }}
      - weight: 50
        preference:
          matchExpressions:
            - key: {{ $key }}
              operator: In
              values:
                - {{ $value | quote }}
      {{- end }}
{{- end }}
{{- if or .tolerations .wan }}
tolerations:
  {{- if .tolerations }}
  {{- toYaml .tolerations | nindent 2 }}
  {{- end }}
  {{- if .wan }}
  {{- include "xaventra.wanTolerations" . | nindent 2 }}
  {{- end }}
{{- end }}
{{- end -}}

{{/* WAN taint + generous unreachable/not-ready tolerations (15 min). */}}
{{- define "xaventra.wanTolerations" -}}
- key: xaventra.ai/wan
  operator: Exists
  effect: PreferNoSchedule
- key: node.kubernetes.io/unreachable
  operator: Exists
  effect: NoExecute
  tolerationSeconds: 900
- key: node.kubernetes.io/not-ready
  operator: Exists
  effect: NoExecute
  tolerationSeconds: 900
{{- end -}}

{{/* Volume source of xaventra.config.json */}}
{{- define "xaventra.configVolume" -}}
- name: config
{{- if .Values.config.existingSecret }}
  secret:
    secretName: {{ .Values.config.existingSecret }}
    defaultMode: 288
{{- else if .Values.config.existingConfigMap }}
  configMap:
    name: {{ .Values.config.existingConfigMap }}
{{- else }}
  configMap:
    name: {{ include "xaventra.fullname" . }}-config
{{- end }}
{{- end -}}
