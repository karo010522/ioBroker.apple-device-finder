# Changelog

Alle nennenswerten Änderungen an diesem Adapter werden hier festgehalten.
Format angelehnt an [Keep a Changelog](https://keepachangelog.com/de/1.0.0/).

## 0.1.0 (Erstveröffentlichung)

- Login via `icloudjs` mit modernem SRP-6a-Verfahren (statt der bei den alten
  Adaptern (`apple-find-me`, `find-my-iphone`) verwendeten, mittlerweile
  nicht mehr funktionierenden Legacy-Anmeldung)
- Automatischer Trigger-Request, damit Apple den 2FA-Code überhaupt an
  vertrauenswürdige Geräte schickt
- Workaround für einen `icloudjs`-Bug, bei dem Apple die 2FA-Code-Bestätigung
  bei manchen Konten mit HTTP 409 statt 204 beantwortet
- 2FA-Code-Eingabe direkt in der Instanz-Konfiguration (kein Umweg über den
  Objektbaum nötig)
- Geräteliste inkl. Akkustand, Position, Adresse (optionales
  Reverse-Geocoding über mehrere wählbare Anbieter)
- Pro Gerät ein/ausblendbarer `showOnMap`-Schalter für Kartenanwendungen
  (z. B. vis-2 + OpenStreetMap)
- Automatischer Retry bei abgeschnittenen Antworten des Apple-Webdienstes
