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

{{/* Downward API + chart facts for the in-cluster detection: dict "root" $ "workload" <name> */}}
{{- define "xaventra.podEnv" -}}
- name: XAVENTRA_POD_NAME
  valueFrom:
    fieldRef:
      fieldPath: metadata.name
- name: NOVA_NODE_ID
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

{{/* Node placement: dict "placement" <map> "affinity" <map> "tolerations" <list> "wan" <bool> */}}
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
  - key: node.kubernetes.io/unreachable
    operator: Exists
    effect: NoExecute
    tolerationSeconds: 900
  - key: node.kubernetes.io/not-ready
    operator: Exists
    effect: NoExecute
    tolerationSeconds: 900
  {{- end }}
{{- end }}
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
