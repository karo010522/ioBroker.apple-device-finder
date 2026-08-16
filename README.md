# ioBroker.apple-device-finder (Apple Device Finder)

Ortet Apple-Geräte (iPhone, iPad, Mac, AirTag über Familienfreigabe) via iCloud
"Find My" – als ioBroker-Adapter mit **zeitgemäßem SRP/2FA-Login**.

## Warum dieses Projekt existiert

Es gab bereits zwei ioBroker-Adapter für diesen Zweck:

- [`ioBroker.find-my-iphone`](https://github.com/iobroker-community-adapters/ioBroker.find-my-iphone) –
  archiviert am 26.04.2023, nicht mehr funktionsfähig.
- [`ioBroker.apple-find-me`](https://github.com/PfisterDaniel/ioBroker.apple-find-me) –
  letztes Release 27.09.2022, seither faktisch unmaintained.

Beide sind an derselben Ursache gescheitert: Apple hat den iCloud-Web-Login
Ende 2024 auf das **SRP-6a-Protokoll** umgestellt. Selbst das mit Abstand
größte Projekt in diesem Bereich, `pyicloud` (Python, Basis für die
Home-Assistant-iCloud-Integration), war dadurch monatelang komplett kaputt.

Dieser Adapter setzt daher nicht auf einen Fork, sondern auf
[**icloudjs**](https://github.com/foxt/icloud.js) – eine aktiv gepflegte
Node.js-Bibliothek, die den modernen SRP-Login samt 2FA-Flow und
persistentem Trust-Token bereits beherrscht (inspiriert von `pyicloud` und
`icloud-photos-sync`).

## Was hier "das Beste aus allen Projekten" bedeutet

| Übernommen von | Was |
|---|---|
| `apple-find-me` | Auswahl an Reverse-Geocoding-Anbietern (HERE, Bing, Google, Geoapify, LocationIQ, PositionStack, TomTom) + kostenlose OSM/Nominatim-Option, moderne Admin-JSON-Config |
| `find-my-iphone` | Pro-Gerät- und globale "Refresh"-Buttons, um Apple nicht unnötig oft anzufragen |
| `icloud.js` (foxt) | Der eigentliche, aktuell funktionierende SRP/2FA-Login inkl. Trust-Token-Persistenz |
| `iCloud3` (Home Assistant) | Vorbild für den Umgang mit wiederkehrenden Login-Problemen: klare State-basierte 2FA-Eingabe statt Konsolen-Interaktion |

## Funktionsumfang (v0.1.0)

- Login mit Apple-ID + Passwort, SRP-Auth, 2FA über einen ioBroker-State
  (`auth.mfaCode`) statt Terminal-Eingabe
- Trust-Token wird persistiert → nach dem ersten 2FA-Login i. d. R. kein
  erneuter Code mehr nötig
- Pro Gerät: Name, Modell, Akkustand, Akkustatus, Position (lat/lon,
  Genauigkeit, Zeitstempel), Stromsparmodus, optional Adresse per
  Reverse-Geocoding
- Manuelles Aktualisieren pro Gerät oder für alle Geräte per Button-State
- Konfigurierbares Poll-Intervall

## Wichtiger Fix: 2FA-Code kommt nicht an

Seit Apples Umstellung auf SRP-6a schickt Apple den 2FA-Code **nicht mehr
automatisch** nach dem Signin-Request. Es ist ein zusätzlicher, expliziter
`GET https://idmsa.apple.com/appleauth/auth/verify/trusteddevice`-Request
mit den Session-Headern des SRP-Logins nötig, um den Push tatsächlich
auszulösen. Ohne diesen Trigger bleibt der Adapter im Status `MfaRequested`
hängen, ohne dass jemals ein Code ankommt.

Dieses Problem betrifft nicht nur diesen Adapter – es wurde z. B. im April
2026 auch für `rclone`s iCloud-Drive-Backend gemeldet und dort auf genau
diese Weise gefixt (Issue `rclone/rclone#9324`).

`main.js` ruft daher direkt nach Erkennen von `status === "MfaRequested"`
die Methode `requestTrustedDeviceCode()` auf, die über
`icloud.authStore.getMfaHeaders()` die nötigen SRP-Session-Header holt und
den fehlenden Trigger-Request manuell nachschickt.

## Wichtiger Fix #2: Korrekter 2FA-Code wird trotzdem mit HTTP 409 abgelehnt

Bei manchen Apple-Accounts antwortet Apple auf die Code-Validierung
(`POST .../verify/trusteddevice/securitycode`) mit **HTTP 409**, obwohl der
eingegebene Code korrekt war - erkennbar am Feld `securityCode.valid: true`
im Response-Body. `icloudjs` (Version 1.6.2) prüft nur den HTTP-Status und
wirft in diesem Fall fälschlich `Invalid status code: 409`, obwohl die
Anmeldung eigentlich weiterlaufen könnte.

Da `icloudjs` intern `node-fetch@2` als eigene Dependency nutzt (nicht
Node.js' globales `fetch`), patcht `main.js` gezielt den Require-Cache-Eintrag
von `node-fetch`, bevor `icloudjs` geladen wird (`patchIcloudNodeFetchForLogging()`).
Dadurch kann der Adapter jeden Request/Response mitschneiden (Debug-Log:
`[fetch->]` / `[fetch<-]`) - und genau diesen einen bekannten Fehlerfall
erkennen und die Antwort transparent mit Status 204 (No Content - der von
`icloudjs` an dieser Stelle erwartete Erfolgscode) statt 409 an `icloudjs`
durchreichen, bevor die Bibliothek selbst den Fehler wirft.

Das ist ein gezielter Workaround für einen Bug in `icloudjs`, kein
allgemeiner "alles auf 200 umbiegen"-Hack: Nur wenn Apple explizit
`securityCode.valid: true` bestätigt, wird der Status korrigiert. Ein
tatsächlich falscher Code führt weiterhin zu einem echten Fehler.

## Wichtiger Fix #3: Gerätenamen waren immer leer

Bei `icloudjs` liegen die eigentlichen Gerätefelder (`name`, `deviceDisplayName`,
`batteryLevel`, `location`, ...) nicht direkt auf dem `iCloudFindMyDevice`-Objekt
aus `findMy.devices`, sondern eine Ebene tiefer unter `device.deviceInfo`. Ein
direkter Zugriff wie `device.name` ist daher **immer** `undefined` - die
`iCloudFindMyDeviceInfo`-Typdefinition in der Doku beschreibt die Struktur von
`device.deviceInfo`, nicht von `device` selbst. `main.js` liest die Felder
jetzt korrekt über `device.deviceInfo`.

## Was (noch) fehlt / bekannte Lücken

- **Geräte liegen unter `devices.<Gerätename>`**, nicht direkt unter der
  Instanz-Root (übersichtlicher neben `auth`/`info`). Objekte aus früheren
  Testläufen mit kryptischen Namen (Rohgeräte-IDs statt Klarname) bleiben als
  Karteileichen bestehen - ioBroker löscht/benennt bestehende Objekte nicht
  automatisch um. Bei Bedarf im Objektbaum manuell löschen.
- **Der "Dieses Gerät aktualisieren"-Button pro Gerät aktualisiert aktuell
  alle Geräte**, nicht nur das eine (die an Apple übergebene Geräte-ID müsste
  die interne Apple-ID sein, nicht der lesbare Name - das ist noch nicht
  sauber verdrahtet).

- **Trust-Token wird bei manchen Accounts nicht dauerhaft gespeichert**: Im
  Log kann `[icloudjs] Unable to write trust token: ... Received null`
  auftauchen. Apple liefert in diesem Fall über den `/2sv/trust`-Request
  keinen Token zurück, weshalb nach jedem Adapter-Neustart erneut ein
  2FA-Code nötig ist. Der Login selbst funktioniert davon unabhängig
  weiterhin einwandfrei - nur eben nicht "silent" nach einem Neustart.

- **Sound abspielen ("Wo ist mein iPhone?")**: `icloudjs` bietet dafür in der
  aktuell verwendeten Version keine öffentliche Methode. Der State
  `<Gerät>.playSound` ist als Platzhalter angelegt, ruft aber aktuell nur
  eine Warnung ins Log. Wer das ergänzen möchte: Der FindMy-Webservice bietet
  einen `playSound`-Request analog zu dem, was `find-my-iphone` (altes
  `alertDevice`) genutzt hat – müsste gegen die aktuelle API nachgebaut werden.
- Kein "Verloren-Modus" / Fernlöschung (bewusst nicht eingebaut – höheres
  Risiko, im Zweifel Original-Apple-Geräte/Web nutzen).
- Kein automatisches "Fallback" auf ein zweites Auth-Verfahren, falls Apple
  den Ablauf erneut ändert.

## Wichtiger Hinweis

Dies ist **inoffizieller** Zugriff auf eine nicht-öffentlich dokumentierte
Apple-Web-API. Das kann jederzeit durch Änderungen bei Apple brechen, und
Apples Nutzungsbedingungen decken automatisierten Zugriff dieser Art nicht
ausdrücklich. Nutzung auf eigenes Risiko – ähnlich wie bei `pyicloud`,
`icloud3` oder den ursprünglichen ioBroker-Adaptern.

## Installation

**Über die ioBroker-Admin-Oberfläche (empfohlen):**

Im Adapter-Tab oben rechts auf das Wolke-Symbol / „Benutzerdefiniert" klicken
und folgende URL eintragen:

```
https://github.com/karo010522/ioBroker.apple-device-finder
```

ioBroker installiert den Adapter direkt von GitHub. **Updates** funktionieren
genauso: Sobald eine neue Version auf GitHub liegt, zeigt die Adapterliste
einen Update-Hinweis, ein Klick genügt.

**Per Kommandozeile (alternativ):**

```bash
cd /opt/iobroker
iobroker url https://github.com/karo010522/ioBroker.apple-device-finder
iobroker add apple-device-finder
```

**Lokal aus dem Quellordner (z. B. für eigene Anpassungen):**

```bash
cd /opt/iobroker
npm install /pfad/zu/iobroker.apple-device-finder --production
iobroker upload apple-device-finder
iobroker add apple-device-finder
```

Danach in der Admin-Oberfläche Apple-ID + Passwort eintragen, Instanz starten
und – falls 2FA aktiv ist – im Bereich "2FA-Code eingeben" derselben
Instanz-Konfigurationsseite den zugeschickten Code eintragen und auf
„Code senden" klicken. Alternativ funktioniert weiterhin die direkte
Eingabe über den Objektbaum (`apple-device-finder.0.auth.mfaCode`).

## Lizenz

MIT – siehe LICENSE. Enthält keinen Code der referenzierten Projekte, nur
konzeptionelle Anleihen (Feature-Ideen), wie oben tabellarisch aufgeführt.
