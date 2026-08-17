const path = require("node:path");
const { tests } = require("@iobroker/testing");

// Einfacher Smoke-Test: Adapter mit Standard-Config starten und prüfen, dass
// er sauber hochkommt, ohne dass echte Apple-ID-Zugangsdaten hinterlegt sind
// (dann bleibt der Adapter im Login-Fehlerpfad, was für diesen Test genügt -
// echte iCloud-Zugangsdaten lassen sich in einer CI-Umgebung ohnehin nicht
// sinnvoll testen, da 2FA einen interaktiven Nutzer voraussetzt).
tests.integration(path.join(__dirname, ".."), {
  defineAdditionalTests({ suite }) {
    suite("Adapter startup", (getHarness) => {
      it("should start without crashing", function () {
        return new Promise((resolve, reject) => {
          const harness = getHarness();
          harness
            .startAdapterAndWait()
            .then(() => {
              resolve();
            })
            .catch(reject);
        });
      }).timeout(30000);
    });
  },
});
