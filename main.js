"use strict";

/*
 * ioBroker.apple-device-finder
 *
 * Ortet Apple-Geräte über den offiziellen(inoffiziellen) iCloud "Find My"-Webdienst.
 *
 * Warum ein neuer Adapter statt eines Forks von apple-find-me / find-my-iphone?
 * Apple hat den iCloud-Login Ende 2024 auf das SRP-6a-Protokoll umgestellt.
 * Die alten Adapter sprachen die iCloud-API noch mit dem simplen
 * Passwort-Login von vor 2024 an - das funktioniert nicht mehr zuverlässig.
 * Dieser Adapter nutzt stattdessen "icloudjs" (https://github.com/foxt/icloud.js),
 * das den modernen SRP+2FA-Login sowie einen persistenten Trust-Token
 * implementiert (kein 2FA-Code bei jedem Neustart nötig).
 *
 * WICHTIG: Dies ist inoffizieller Reverse-Engineering-Zugriff auf Apples
 * Web-API. Apple kann den Ablauf jederzeit wieder ändern. Nutzung auf
 * eigenes Risiko, siehe README.
 */

const utils = require("@iobroker/adapter-core");
const path = require("node:path");
const fs = require("node:fs");
const https = require("node:https");

// icloudjs wird lazy geladen, damit der Adapter auch dann sauber startet/lint-bar bleibt,
// wenn npm install noch nicht gelaufen ist.
let iCloud;

const { reverseGeocode } = require("./lib/geocode");

class AppleDeviceFinder extends utils.Adapter {
  constructor(options) {
    super({
      ...options,
      name: "apple-device-finder",
    });

    this.icloud = null;
    this.pollTimer = null;
    this.mfaWaitingResolve = null;

    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  /**
   * icloudjs nutzt intern node-fetch@2 (eigene Dependency), NICHT das globale
   * fetch von Node.js. Um die tatsächlichen Requests/Responses beim Login zu
   * sehen, ersetzen wir den Require-Cache-Eintrag von node-fetch - und zwar
   * exakt an dem Pfad, den icloudjs selbst beim internen require('node-fetch')
   * auflösen würde (node_modules-Auflösung relativ zu icloudjs' eigenem Ordner).
   * Muss VOR dem ersten require("icloudjs") passieren.
   */
  patchIcloudNodeFetchForLogging() {
    try {
      const icloudjsEntry = require.resolve("icloudjs");
      const icloudjsDir = path.dirname(icloudjsEntry);
      const nodeFetchPath = require.resolve("node-fetch", { paths: [icloudjsDir] });

      if (require.cache[nodeFetchPath] && require.cache[nodeFetchPath].__ourPatch) {
        return; // schon gepatcht
      }

      const realFetch = require(nodeFetchPath);
      const self = this;
      const wrapped = async function (url, opts) {
        let res = await realFetch(url, opts);

        // BUGFIX: Bei manchen Apple-Accounts antwortet Apple auf die
        // 2FA-Code-Validierung (.../verify/trusteddevice/securitycode) mit
        // HTTP 409, OBWOHL der Code korrekt war - erkennbar am Feld
        // securityCode.valid === true im Response-Body. icloudjs behandelt
        // jeden Nicht-200-Status pauschal als Fehler und wirft dann fälschlich
        // "Invalid status code: 409", obwohl die Anmeldung eigentlich
        // weiterlaufen könnte. Wir erkennen genau dieses Muster und reichen
        // stattdessen eine Antwort mit Status 204 (No Content) durch, was
        // icloudjs an dieser Stelle als Erfolg erwartet.
        try {
          if (typeof url === "string" && url.includes("/securitycode") && res.status === 409) {
            const text = await res.clone().text();
            let parsed = null;
            try {
              parsed = JSON.parse(text);
            } catch (e) {
              /* keine JSON-Antwort - Fix nicht anwendbar */
            }
            if (parsed && parsed.securityCode && parsed.securityCode.valid === true) {
              self.log.debug("[fetch-fix] HTTP 409 mit securityCode.valid=true -> als HTTP 204 durchgereicht");
              res = new realFetch.Response("", { status: 204, statusText: "No Content", headers: res.headers });
            }
          }
        } catch (fixErr) {
          self.log.debug("Konnte 409/valid-Fix nicht anwenden: " + fixErr.message);
        }

        return res;
      };
      Object.assign(wrapped, realFetch); // node-fetch v2 hängt Headers/Request/Response/FetchError an die Funktion
      wrapped.__ourPatch = true;

      if (require.cache[nodeFetchPath]) {
        require.cache[nodeFetchPath].exports = wrapped;
      } else {
        require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: wrapped };
      }
      this.log.debug("node-fetch-Logging für icloudjs aktiviert (" + nodeFetchPath + ")");
    } catch (e) {
      this.log.debug("Konnte node-fetch für Logging nicht patchen: " + e.message);
    }
  }

  async onReady() {
    // icloudjs erst hier requiren, nach dem Adapterstart
    // Muss VOR dem ersten require("icloudjs") passieren, damit unser
    // gepatchtes node-fetch im Require-Cache liegt, bevor icloudjs es lädt.
    this.patchIcloudNodeFetchForLogging();

    try {
      iCloud = require("icloudjs").default || require("icloudjs");
    } catch (e) {
      this.log.error(
        "Das Modul 'icloudjs' konnte nicht geladen werden. Bitte 'npm install' im Adapterverzeichnis ausführen. " +
          e.message
      );
      return;
    }

    if (!this.config.username || !this.config.password) {
      this.log.error("Bitte Apple-ID (Benutzername) und Passwort in den Adaptereinstellungen hinterlegen.");
      return;
    }

    await this.setObjectNotExistsAsync("auth.mfaCode", {
      type: "state",
      common: { role: "text", name: "2FA-Code eintragen", type: "string", read: true, write: true, def: "" },
      native: {},
    });
    this.subscribeStates("auth.mfaCode");
    this.subscribeStates("refreshAll");

    await this.setStateAsync("info.connection", { val: false, ack: true });

    await this.login();

    const intervalMinutes = Math.max(1, Number(this.config.pollInterval) || 5);
    this.pollTimer = this.setInterval(() => this.pollDevices(), intervalMinutes * 60 * 1000);
  }

  /**
   * Ordner, in dem icloudjs den Trust-Token persistiert (damit nicht bei
   * jedem Adapter-Neustart erneut ein 2FA-Code nötig ist).
   */
  getSessionDir() {
    // ioBroker legt für jeden Adapter einen eigenen Datenordner unterhalb von
    // <iobroker-data>/files/<adapter>.<instance>/ an. Wir nutzen stattdessen
    // einen einfachen Unterordner neben dem Adapter selbst, das ist stabil
    // über Neustarts (nicht aber über eine Neuinstallation) hinweg.
    const dir = path.join(utils.getAbsoluteInstanceDataDir ? utils.getAbsoluteInstanceDataDir(this) : __dirname, "icloud-session");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.log.warn("Konnte Session-Verzeichnis nicht anlegen, nutze Fallback im Adapterordner: " + e.message);
      return path.join(__dirname, ".icloud-session");
    }
    return dir;
  }

  async login() {
    try {
      this.icloud = new iCloud({
        username: this.config.username,
        password: this.decrypt(this.config.password),
        saveCredentials: false,
        trustDevice: this.config.trustDevice !== false,
        authMethod: this.config.authMethod || "srp",
        dataDirectory: this.getSessionDir(),
        logger: (level, ...args) => {
          // icloudjs Loglevel: 0=debug .. 3=error (siehe README der Bibliothek)
          const msg = args.join(" ");
          if (level >= 3) this.log.error("[icloudjs] " + msg);
          else if (level >= 2) this.log.warn("[icloudjs] " + msg);
          else this.log.debug("[icloudjs] " + msg);
        },
      });

      await this.icloud.authenticate();

      if (this.icloud.status === "MfaRequested") {
        // WICHTIG: Seit Apples SRP-Umstellung schickt Apple den Push nicht mehr
        // automatisch nach dem Signin-Request. Es muss zusätzlich explizit ein
        // GET auf /verify/trusteddevice gesendet werden, sonst kommt bei vielen
        // Accounts nie ein Code an (bestätigt u.a. in rclone-Issue #9324,
        // April 2026, gleiches Problem bei mehreren iCloud-Tools).
        await this.requestTrustedDeviceCode();
        this.log.info(
          "2FA-Code wurde bei Apple angefordert und sollte jetzt an deine vertrauenswürdigen Geräte " +
            "geschickt werden. Bitte den Code im State 'auth.mfaCode' eintragen."
        );
        await this.setStateAsync("auth.mfaRequired", { val: true, ack: true });
        await this.waitForMfaCode();
        await this.setStateAsync("auth.mfaRequired", { val: false, ack: true });
      }

      await this.icloud.awaitReady;
      await this.setStateAsync("info.connection", { val: true, ack: true });
      await this.setStateAsync("auth.lastError", { val: "", ack: true });
      this.log.info("Erfolgreich bei iCloud angemeldet als " + this.config.username);

      await this.pollDevices();
    } catch (err) {
      await this.setStateAsync("info.connection", { val: false, ack: true });
      await this.setStateAsync("auth.lastError", { val: String(err && err.message ? err.message : err), ack: true });
      this.log.error(
        "iCloud-Anmeldung fehlgeschlagen: " +
          (err && err.message ? err.message : err) +
          ". Häufige Ursachen: falsches Passwort, App-spezifisches Passwort statt normalem Passwort " +
          "nötig, oder Apple hat den Login-Ablauf erneut geändert (siehe README)."
      );
    }
  }

  /**
   * Löst den fehlenden Trigger für den 2FA-Push an vertrauenswürdige Geräte aus.
   * icloudjs stellt selbst keine High-Level-Methode dafür bereit (Stand der
   * genutzten Version), aber die authStore-Instanz hat bereits alle nötigen
   * Session-Header (scnt, X-Apple-ID-Session-Id, Cookies) über getMfaHeaders().
   * Wir schicken damit denselben Request, den auch der Apple-eigene Web-Login macht.
   */
  requestTrustedDeviceCode() {
    return new Promise((resolve) => {
      try {
        const headers = this.icloud.authStore.getMfaHeaders();
        const req = https.request(
          {
            hostname: "idmsa.apple.com",
            path: "/appleauth/auth/verify/trusteddevice",
            method: "GET",
            headers,
          },
          (res) => {
            let data = "";
            res.on("data", (chunk) => (data += chunk));
            res.on("end", () => {
              this.log.debug(`requestTrustedDeviceCode Antwort: HTTP ${res.statusCode}`);
              // WICHTIG: Apple gibt bei diesem Request oft aktualisierte Session-Cookies
              // (u.a. "aasp") und teils ein neues "scnt" zurück. Werden die nicht in
              // icloudjs' authStore übernommen, verwendet provideMfaCode() später noch
              // die alten Werte -> Apple lehnt den (korrekten!) Code mit HTTP 409 ab,
              // weil die Session nicht mehr zusammenpasst.
              try {
                const setCookie = res.headers["set-cookie"];
                if (setCookie && setCookie.length) {
                  // icloudjs legt icloudCookies offenbar erst an, sobald die erste
                  // "richtige" iCloud-Setup-Antwort verarbeitet wurde. Mitten im
                  // 2FA-Flow existiert das Array teils noch nicht -> defensiv anlegen.
                  if (!Array.isArray(this.icloud.authStore.icloudCookies)) {
                    this.icloud.authStore.icloudCookies = [];
                  }
                  this.icloud.authStore.addCookies(setCookie);
                }
                if (res.headers["scnt"]) {
                  this.icloud.authStore.scnt = res.headers["scnt"];
                }
                if (res.headers["x-apple-id-session-id"]) {
                  this.icloud.authStore.sessionId = res.headers["x-apple-id-session-id"];
                }
              } catch (mergeErr) {
                this.log.debug("Konnte Session-Header aus Trigger-Antwort nicht übernehmen: " + mergeErr.message);
              }
              resolve();
            });
          }
        );
        req.on("error", (err) => {
          this.log.warn("Konnte 2FA-Push nicht explizit anfordern: " + err.message);
          resolve();
        });
        req.end();
      } catch (err) {
        this.log.warn("Konnte 2FA-Push nicht explizit anfordern: " + err.message);
        resolve();
      }
    });
  }

  waitForMfaCode() {
    return new Promise((resolve) => {
      this.mfaWaitingResolve = resolve;
    });
  }

  async onStateChange(id, state) {
    if (!state || state.ack) return;

    if (id.endsWith("auth.mfaCode") && state.val) {
      const code = String(state.val).trim();
      await this.setStateAsync(id, { val: "", ack: true });
      await this.submitMfaCode(code);
    }

    if (id.endsWith("refreshAll") && state.val) {
      await this.setStateAsync(id, { val: false, ack: true });
      await this.pollDevices();
    }

    // <deviceId>.refresh und <deviceId>.playSound werden dynamisch pro Gerät angelegt,
    // siehe ensureDeviceObjects()
    const refreshMatch = id.match(/\.(devices\.[^.]+)\.refresh$/);
    if (refreshMatch && state.val) {
      await this.setStateAsync(id, { val: false, ack: true });
      await this.pollDevices();
    }

    const soundMatch = id.match(/\.(devices\.[^.]+)\.playSound$/);
    if (soundMatch && state.val) {
      await this.setStateAsync(id, { val: false, ack: true });
      await this.playSound(soundMatch[1]);
    }
  }

  async pollDevices(onlyDeviceId, isRetry) {
    // icloudjs durchläuft nach dem Login: Started -> MfaRequested -> Authenticated -> Ready.
    // "Ready" ist der eigentliche finale "einsatzbereit"-Status (auf den auch
    // icloud.awaitReady wartet) - "Authenticated" allein reicht noch nicht.
    if (!this.icloud || this.icloud.status !== "Ready") {
      this.log.debug("Überspringe Poll, keine gültige iCloud-Sitzung (Status: " + (this.icloud && this.icloud.status) + ")");
      return;
    }

    try {
      const findMy = this.icloud.getService("findme");
      findMy.includeFamily = !!this.config.includeFamily;

      await findMy.refresh(onlyDeviceId);
      await this.setStateAsync("info.connection", { val: true, ack: true });

      const mapExportEntries = [];

      for (const [rawId, device] of findMy.devices) {
        // WICHTIG: Die eigentlichen Gerätefelder (name, deviceDisplayName, batteryLevel,
        // location, ...) liegen bei icloudjs nicht direkt auf dem Map-Value, sondern
        // eine Ebene tiefer unter device.deviceInfo. Direkte Zugriffe wie device.name
        // sind IMMER undefined.
        const info = device.deviceInfo || device;
        const displayName = info.name || info.deviceDisplayName || info.modelDisplayName || rawId;
        const safeId = "devices." + this.cleanId(displayName);
        await this.ensureDeviceObjects(safeId, displayName);

        await this.setStateAsync(`${safeId}.name`, { val: displayName, ack: true });
        await this.setStateAsync(`${safeId}.deviceModel`, { val: info.deviceModel, ack: true });
        await this.setStateAsync(`${safeId}.modelDisplayName`, { val: info.modelDisplayName, ack: true });
        await this.setStateAsync(`${safeId}.batteryLevel`, {
          val: typeof info.batteryLevel === "number" ? Math.round(info.batteryLevel * 100) : null,
          ack: true,
        });
        await this.setStateAsync(`${safeId}.batteryStatus`, { val: info.batteryStatus, ack: true });
        await this.setStateAsync(`${safeId}.isLocating`, { val: !!info.isLocating, ack: true });
        await this.setStateAsync(`${safeId}.lowPowerMode`, { val: !!info.lowPowerMode, ack: true });
        await this.setStateAsync(`${safeId}.lostModeCapable`, { val: !!info.lostModeCapable, ack: true });

        if (info.location) {
          await this.setStateAsync(`${safeId}.latitude`, { val: info.location.latitude, ack: true });
          await this.setStateAsync(`${safeId}.longitude`, { val: info.location.longitude, ack: true });
          await this.setStateAsync(`${safeId}.horizontalAccuracy`, { val: info.location.horizontalAccuracy, ack: true });
          await this.setStateAsync(`${safeId}.isOld`, { val: !!info.location.isOld, ack: true });
          await this.setStateAsync(`${safeId}.positionType`, { val: info.location.positionType, ack: true });
          await this.setStateAsync(`${safeId}.lastLocationUpdate`, { val: info.location.timeStamp, ack: true });

          let address = null;
          if (this.config.geocodeProvider && this.config.geocodeProvider !== "none") {
            try {
              address = await reverseGeocode(
                this.config.geocodeProvider,
                this.decrypt(this.config.geocodeApiKey),
                info.location.latitude,
                info.location.longitude,
                this.config.geocodeLanguage || "de"
              );
              if (address) await this.setStateAsync(`${safeId}.address`, { val: address, ack: true });
            } catch (geoErr) {
              this.log.debug(`Reverse-Geocoding für ${safeId} fehlgeschlagen: ${geoErr.message}`);
            }
          }

          mapExportEntries.push({
            id: safeId.replace(/^devices\./, ""),
            name: displayName,
            latitude: info.location.latitude,
            longitude: info.location.longitude,
            horizontalAccuracy: info.location.horizontalAccuracy,
            isOld: !!info.location.isOld,
            batteryLevel: typeof info.batteryLevel === "number" ? Math.round(info.batteryLevel * 100) : null,
            batteryStatus: info.batteryStatus || null,
            address: address || null,
            lastLocationUpdate: info.location.timeStamp || null,
          });
        }

        await this.setStateAsync(`${safeId}.lastUpdate`, { val: Date.now(), ack: true });
      }

      await this.writeMapExport(mapExportEntries);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      // Apple liefert bei diesem Endpoint gelegentlich eine abgeschnittene/leere
      // Antwort zurück ("invalid json response body ... Unexpected end of JSON
      // input"), obwohl die Session gültig ist. Ein einmaliger, kurz verzögerter
      // Retry löst das in der Praxis fast immer - ohne Retry würde sonst jeder
      // betroffene Poll-Zyklus komplett ausfallen.
      if (isRetry === undefined && /invalid json|unexpected end of json/i.test(msg)) {
        this.log.debug("Abgeschnittene Antwort von Apple erhalten, versuche einmaligen Retry in 3s...");
        await new Promise((resolve) => this.setTimeout(resolve, 3000));
        return this.pollDevices(onlyDeviceId, true);
      }
      if (isRetry === true && /invalid json|unexpected end of json/i.test(msg)) {
        // Auch der Retry ist abgeschnitten. WICHTIG: Hier NICHT this.login() aufrufen -
        // bei diesem Account liefert Apple keinen Trust-Token zurück (siehe README),
        // ein volles Neu-Login würde also jedes Mal wieder einen 2FA-Code erzwingen
        // und die Karte alle paar Minuten unbenutzbar machen. Stattdessen nur die
        // interne FindMy-Service-Instanz verwerfen, damit icloudjs beim nächsten
        // getService("findme") eine frische Instanz (neue serviceUri/Session) anlegt,
        // ohne die bestehende SRP-Anmeldung anzutasten.
        this.log.warn("Wiederholter Abruf ebenfalls abgeschnitten - setze FindMy-Service-Sitzung zurück und versuche es noch einmal.");
        try {
          if (this.icloud._serviceCache) delete this.icloud._serviceCache.findme;
        } catch (cacheErr) {
          this.log.debug("Konnte FindMy-Service-Cache nicht zurücksetzen: " + cacheErr.message);
        }
        await new Promise((resolve) => this.setTimeout(resolve, 2000));
        return this.pollDevices(onlyDeviceId, "final");
      }
      if (isRetry === "final") {
        this.log.error(
          "Geräteabruf bleibt abgeschnitten, auch nach Service-Reset. Nächster Versuch beim nächsten " +
            "regulären Poll-Intervall."
        );
        return;
      }
      this.log.error("Fehler beim Abrufen der Geräte: " + msg);
      // Bei bestimmten Fehlern (Session abgelaufen) neu einloggen versuchen
      if (msg.includes("401") || msg.toLowerCase().includes("auth")) {
        this.log.info("Versuche erneute Anmeldung nach Auth-Fehler...");
        await this.login();
      }
    }
  }

  /**
   * Schreibt einen gefilterten JSON-Snapshot der Gerätepositionen auf die Platte,
   * den die separate Karten-App (eigener Docker-Container) über ein gemeinsames
   * Volume liest. Es werden NUR die Geräte exportiert, die in der Config-Allowlist
   * stehen (mapExportDevices, kommasepariert) - leer = alle Geräte. So bestimmt
   * man vorab, welche Standorte die ioBroker-Instanz überhaupt verlassen.
   */
  async writeMapExport(entries) {
    if (!this.config.mapExportEnabled) return;

    const allowlist = String(this.config.mapExportDevices || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const filtered = allowlist.length ? entries.filter((e) => allowlist.includes(e.id)) : entries;

    const exportPath = this.config.mapExportPath || "/opt/iobroker/apple-device-finder-map/devices.json";

    try {
      const dir = path.dirname(exportPath);
      fs.mkdirSync(dir, { recursive: true });
      const payload = {
        generatedAt: new Date().toISOString(),
        devices: filtered,
      };
      fs.writeFileSync(exportPath, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      this.log.warn("Konnte Map-Export nicht schreiben (" + exportPath + "): " + err.message);
    }
  }

  async playSound(safeId) {
    // Hinweis: icloudjs stellt aktuell keine High-Level-Methode zum Abspielen eines Sounds
    // bereit (Stand der genutzten Version). Dieser Platzhalter zeigt, wo der Aufruf der
    // "Play Sound"-Aktion des FindMy-Webservices ergänzt werden müsste, sobald icloudjs
    // (oder ein PR dagegen) das unterstützt. Siehe README, Abschnitt "Bekannte Lücken".
    this.log.warn(
      "playSound für " + safeId + " ist in dieser Version noch nicht implementiert (icloudjs bietet dafür " +
        "aktuell keine öffentliche Methode). Siehe README."
    );
  }

  async ensureDeviceObjects(safeId, displayName) {
    await this.setObjectNotExistsAsync("devices", { type: "channel", common: { name: "Geräte" }, native: {} });
    await this.setObjectNotExistsAsync(safeId, { type: "channel", common: { name: displayName || safeId }, native: {} });

    const states = {
      name: { role: "text", name: "Gerätename", type: "string" },
      deviceModel: { role: "text", name: "Geräte-Modell (intern)", type: "string" },
      modelDisplayName: { role: "text", name: "Modellbezeichnung", type: "string" },
      batteryLevel: { role: "value.battery", name: "Akkustand (%)", type: "number", unit: "%" },
      batteryStatus: { role: "text", name: "Akkustatus", type: "string" },
      isLocating: { role: "indicator", name: "Ortung aktiv", type: "boolean" },
      lowPowerMode: { role: "indicator", name: "Stromsparmodus", type: "boolean" },
      lostModeCapable: { role: "indicator", name: "Verloren-Modus möglich", type: "boolean" },
      latitude: { role: "value.gps.latitude", name: "Breitengrad", type: "number" },
      longitude: { role: "value.gps.longitude", name: "Längengrad", type: "number" },
      horizontalAccuracy: { role: "value", name: "Positionsgenauigkeit (m)", type: "number", unit: "m" },
      isOld: { role: "indicator", name: "Position veraltet", type: "boolean" },
      positionType: { role: "text", name: "Art der Positionsbestimmung", type: "string" },
      lastLocationUpdate: { role: "value.time", name: "Zeitstempel letzte Ortung (Apple)", type: "number" },
      address: { role: "text", name: "Adresse (reverse-geocoded)", type: "string" },
      lastUpdate: { role: "value.time", name: "Zeitstempel letzter Abruf", type: "number" },
      refresh: { role: "button", name: "Dieses Gerät jetzt aktualisieren", type: "boolean", write: true, def: false },
      playSound: { role: "button", name: "Ton abspielen (Piepsen)", type: "boolean", write: true, def: false },
      showOnMap: { role: "switch.enable", name: "Auf Karte anzeigen", type: "boolean", write: true, def: true },
    };

    for (const [key, common] of Object.entries(states)) {
      await this.setObjectNotExistsAsync(`${safeId}.${key}`, {
        type: "state",
        common: { read: true, write: false, ...common },
        native: {},
      });
    }
    this.subscribeStates(`${safeId}.refresh`);
    this.subscribeStates(`${safeId}.playSound`);
  }

  cleanId(name) {
    return String(name)
      .replace(/[^a-zA-Z0-9_äöüÄÖÜß -]/g, "")
      .trim()
      .replace(/\s+/g, "_");
  }

  decrypt(value) {
    // ioBroker verschlüsselt Felder aus "encryptedNative" automatisch mit dem
    // System-Secret. Der js-controller entschlüsselt sie i.d.R. bereits vor
    // dem Übergeben an this.config - dieser Wrapper ist ein Sicherheitsnetz
    // für den Fall abweichender Konfigurationen.
    return value;
  }

  /**
   * Nimmt einen 2FA-Code entgegen - egal ob er über den State auth.mfaCode
   * oder über den "Code senden"-Button in der Instanz-Konfiguration (sendTo)
   * hereingekommen ist.
   * @returns {Promise<{success?: string, error?: string}>}
   */
  async submitMfaCode(code) {
    code = String(code || "").trim();
    if (!code) {
      return { error: "Kein Code eingegeben." };
    }
    if (!this.icloud || this.icloud.status !== "MfaRequested") {
      const msg =
        "Es wird gerade kein 2FA-Code erwartet (Instanz evtl. noch nicht bereit, schon angemeldet, " +
        "oder muss erst gestartet/neugestartet werden, damit ein neuer Code angefordert wird).";
      this.log.warn(msg);
      return { error: msg };
    }
    try {
      await this.icloud.provideMfaCode(code);
      this.log.info("2FA-Code akzeptiert.");
      if (this.mfaWaitingResolve) {
        this.mfaWaitingResolve();
        this.mfaWaitingResolve = null;
      }
      return { success: "Code akzeptiert, Anmeldung läuft weiter." };
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      if (msg.includes("409")) {
        this.log.error(
          "2FA-Code wurde abgelehnt (HTTP 409). Der automatische Fix für den bekannten " +
            "'409-trotz-korrektem-Code'-Fall hat hier nicht gegriffen - vermutlich war der Code tatsächlich " +
            "falsch/abgelaufen oder die Session ist nicht mehr synchron. Instanz neu starten und neuen Code eintragen."
        );
        return { error: "Code abgelehnt (409). Instanz neu starten und neuen Code eintragen." };
      }
      this.log.error("2FA-Code wurde von Apple abgelehnt: " + msg);
      return { error: "Code wurde von Apple abgelehnt: " + msg };
    }
  }

  async onMessage(obj) {
    if (!obj || typeof obj !== "object" || !obj.command) return;

    if (obj.command === "submitMfaCode") {
      const code = obj.message && obj.message.code;
      const result = await this.submitMfaCode(code);
      if (obj.callback) this.sendTo(obj.from, obj.command, result, obj.callback);
      return;
    }
  }

  onUnload(callback) {
    try {
      if (this.pollTimer) this.clearInterval(this.pollTimer);
      callback();
    } catch (e) {
      callback();
    }
  }
}

if (require.main !== module) {
  module.exports = (options) => new AppleDeviceFinder(options);
} else {
  new AppleDeviceFinder();
}
