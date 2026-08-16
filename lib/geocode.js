"use strict";

/*
 * Reverse-Geocoding: aus lat/lon eine lesbare Adresse machen.
 *
 * Übernimmt die Idee aus ioBroker.apple-find-me, mehrere Anbieter zur Auswahl
 * zu stellen (dort per API-Key konfigurierbar: HERE, Bing, Google, Geoapify,
 * LocationIQ, PositionStack, TomTom). Zusätzlich: OpenStreetMap/Nominatim als
 * kostenloser Standard ohne API-Key (bitte Nominatim Nutzungsbedingungen /
 * Rate-Limits beachten - für den Privatgebrauch mit wenigen Geräten und
 * einem Poll-Intervall von mehreren Minuten unkritisch).
 */

const https = require("https");

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https
      .get(url, { headers: { "User-Agent": "ioBroker.apple-device-finder", ...headers } }, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error("Ungültige Antwort vom Geocoding-Dienst: " + e.message));
          }
        });
      })
      .on("error", reject);
  });
}

async function reverseGeocode(provider, apiKey, lat, lon, lang) {
  switch (provider) {
    case "nominatim": {
      const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&accept-language=${lang}`;
      const json = await httpGetJson(url);
      return json && json.display_name;
    }
    case "here": {
      if (!apiKey) return null;
      const url = `https://revgeocode.search.hereapi.com/v1/revgeocode?at=${lat},${lon}&lang=${lang}&apiKey=${apiKey}`;
      const json = await httpGetJson(url);
      return json && json.items && json.items[0] && json.items[0].address && json.items[0].address.label;
    }
    case "bing": {
      if (!apiKey) return null;
      const url = `https://dev.virtualearth.net/REST/v1/Locations/${lat},${lon}?key=${apiKey}`;
      const json = await httpGetJson(url);
      return (
        json &&
        json.resourceSets &&
        json.resourceSets[0] &&
        json.resourceSets[0].resources &&
        json.resourceSets[0].resources[0] &&
        json.resourceSets[0].resources[0].name
      );
    }
    case "google": {
      if (!apiKey) return null;
      const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lon}&language=${lang}&key=${apiKey}`;
      const json = await httpGetJson(url);
      return json && json.results && json.results[0] && json.results[0].formatted_address;
    }
    case "geoapify": {
      if (!apiKey) return null;
      const url = `https://api.geoapify.com/v1/geocode/reverse?lat=${lat}&lon=${lon}&lang=${lang}&apiKey=${apiKey}`;
      const json = await httpGetJson(url);
      return (
        json &&
        json.features &&
        json.features[0] &&
        json.features[0].properties &&
        json.features[0].properties.formatted
      );
    }
    case "locationiq": {
      if (!apiKey) return null;
      const url = `https://us1.locationiq.com/v1/reverse?key=${apiKey}&lat=${lat}&lon=${lon}&format=json&accept-language=${lang}`;
      const json = await httpGetJson(url);
      return json && json.display_name;
    }
    case "positionstack": {
      if (!apiKey) return null;
      const url = `http://api.positionstack.com/v1/reverse?access_key=${apiKey}&query=${lat},${lon}`;
      const json = await httpGetJson(url);
      return json && json.data && json.data[0] && json.data[0].label;
    }
    case "tomtom": {
      if (!apiKey) return null;
      const url = `https://api.tomtom.com/search/2/reverseGeocode/${lat},${lon}.json?key=${apiKey}&language=${lang}`;
      const json = await httpGetJson(url);
      return (
        json &&
        json.addresses &&
        json.addresses[0] &&
        json.addresses[0].address &&
        json.addresses[0].address.freeformAddress
      );
    }
    case "none":
    default:
      return null;
  }
}

module.exports = { reverseGeocode };
