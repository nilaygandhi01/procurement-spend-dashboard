{{/* Common template helpers */}}

{{- define "psd.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "psd.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "psd.labels" -}}
app.kubernetes.io/name: {{ include "psd.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
mckinsey.io/sensitive-data: "client"
mckinsey.io/client: "cummins"
mckinsey.io/visibility: "firm-internal"
{{- end -}}

{{- define "psd.selectorLabels" -}}
app.kubernetes.io/name: {{ include "psd.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
