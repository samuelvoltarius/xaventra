# Paketverfolgung

`parcel_track` liest einen belegten Sendungsstatus. Der authentifizierte Owner muss Trackingnummer und Abfragedienst im aktuellen Auftrag nennen, zum Beispiel „Verfolge DHL 12345678“. Das Nummernformat bestätigt keinen Paketdienst.

- DHL: `XAVENTRA_DHL_TRACKING_API_KEY` privat in der Service-Umgebung hinterlegen. Dokumentation: https://developer.dhl.com/tracking
- 17TRACK: `XAVENTRA_17TRACK_TOKEN` privat hinterlegen. Nur bereits registrierte Sendungen werden über `gettrackinfo` gelesen; Antworten können gecacht sein. Dokumentation: https://api.17track.net/en/doc

Ohne Zugang fragt Nova nach der Einrichtung. Schlüssel gehören nicht in Chats, Git oder Projektgedächtnis. Nova registriert keine Sendungen, kauft keine Credits und verwendet keine kostenpflichtige Echtzeitabfrage. Es gibt keinen automatischen Wechsel des Abfragedienstes. HTTP-Fehler, unbekannte Sendungen oder fehlender Status gelten nicht als Erfolg. Ereigniszeit und Abfragezeit werden getrennt ausgegeben; Empfänger- und Adressdaten werden nicht weitergereicht.

Nicht jeder Anbieter ist abgedeckt. Die Integration ist mit API-Fixtures geprüft; echte Sendungen benötigen einen freigegebenen Zugang. Dauerüberwachung und Benachrichtigungen sind nicht Teil dieses Lesewerkzeugs.
