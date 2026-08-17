# ioBroker.apple-device-finder

Locate Apple devices (iPhone, iPad, Mac, AirTag via Family Sharing) via
iCloud "Find My" - an ioBroker adapter with a **modern SRP/2FA login**.

## Why this project exists

There were already two ioBroker adapters for this purpose:

- [`ioBroker.find-my-iphone`](https://github.com/iobroker-community-adapters/ioBroker.find-my-iphone) -
  archived on 2023-04-26, no longer functional.
- [`ioBroker.apple-find-me`](https://github.com/PfisterDaniel/ioBroker.apple-find-me) -
  last release 2022-09-27, effectively unmaintained since.

Both failed for the same reason: Apple switched the iCloud web login to the
**SRP-6a protocol** in late 2024. Even the by far largest project in this
space, `pyicloud` (Python, the basis for the Home Assistant iCloud
integration), was completely broken by this for months.

This adapter therefore doesn't build on a fork, but on
[**icloudjs**](https://github.com/foxt/icloud.js) - an actively maintained
Node.js library that already handles the modern SRP login together with the
2FA flow and a persistent trust token (inspired by `pyicloud` and
`icloud-photos-sync`).

## What "the best of all projects" means here

| Taken from | What |
|---|---|
| `apple-find-me` | Choice of reverse-geocoding providers (HERE, Bing, Google, Geoapify, LocationIQ, PositionStack, TomTom) plus a free OSM/Nominatim option, modern admin JSON config |
| `find-my-iphone` | Per-device and global "refresh" buttons to avoid querying Apple unnecessarily often |
| `icloud.js` (foxt) | The actual, currently working SRP/2FA login including trust-token persistence |
| `iCloud3` (Home Assistant) | Model for handling recurring login issues: clear state-based 2FA input instead of console interaction |

## Features

- Login with Apple ID + password, SRP auth, 2FA via an ioBroker state
  (`auth.mfaCode`) or directly in the instance configuration, instead of
  terminal input
- Trust token is persisted -> usually no repeated 2FA code needed after the
  first login (may not apply to every account, see Known limitations)
- Per device: name, model, battery level, battery status, position (lat/lon,
  accuracy, timestamp), low power mode, optional address via
  reverse geocoding
- Manual refresh per device or for all devices via a button state
- Configurable poll interval
- Optional per-device `showOnMap` switch for use in map dashboards (e.g.
  vis-2 + OpenStreetMap)
- Automatic retry when the Apple web service returns a truncated response

## Notable fixes included in this adapter

Since Apple's switch to SRP-6a, several undocumented quirks in Apple's own
web login had to be worked around. Details are kept in the source code
comments in `main.js`, in short:

- Apple no longer automatically sends the 2FA push after the sign-in
  request; an additional explicit trigger request is required (the same
  issue was reported for `rclone`'s iCloud Drive backend in April 2026,
  `rclone/rclone#9324`).
- On some Apple accounts, `icloudjs` (v1.6.2) incorrectly rejects a
  **correct** 2FA code because Apple responds with HTTP 409 instead of the
  expected 204, even though the response body confirms the code was valid.
  The adapter detects this specific pattern and corrects the response
  before it reaches the library.
- The actual device fields (`name`, `deviceDisplayName`, `batteryLevel`,
  `location`, ...) are nested one level deeper under `device.deviceInfo` in
  `icloudjs`, not directly on the device object - a common source of
  `undefined` values if accessed incorrectly.

## Known limitations

- Devices are grouped under `devices.<DeviceName>`. Objects from earlier
  test runs with cryptic names (raw device IDs instead of readable names)
  may remain as orphaned objects, since ioBroker does not rename existing
  objects automatically - remove them manually from the object tree if
  needed.
- The per-device "refresh" button currently refreshes all devices, not only
  the selected one.
- On some accounts, Apple does not return a trust token via the
  `/2sv/trust` request (visible in the log as
  `[icloudjs] Unable to write trust token: ... Received null`). In that
  case, a new 2FA code is required after every adapter restart. Login
  itself keeps working correctly regardless.
- "Play Sound" is not implemented yet; `icloudjs` does not currently expose
  a public method for it. The `<device>.playSound` state exists as a
  placeholder and only logs a warning for now.
- No "Lost Mode" / remote wipe (intentionally not implemented - higher
  risk; use the official Apple device or web UI if needed).
- No automatic fallback to a second authentication method if Apple changes
  the login flow again.

## Important notice

This adapter relies on an **unofficial** and undocumented Apple web API.
It can break at any time due to changes on Apple's side, and Apple's terms
of service do not explicitly cover this kind of automated access. Use at
your own risk - similar to `pyicloud`, `icloud3`, or the original ioBroker
adapters this project succeeds.

## Changelog

<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### 0.1.3 (2026-08-17)

- (KaRo010522) Fixed adapter-checker findings: added missing translations,
  tier, licenseInformation, updated dependency versions

### 0.1.2 (2026-08-16)

- (KaRo010522) Fixed adapter-checker findings: added missing translations,
  tier, licenseInformation, updated dependency versions

### 0.1.1 (2026-08-16)

- (KaRo010522) Fixed device polling after session refresh, reduced verbose
  logging, new icon and name

### 0.1.0 (2026-08-16)

- (KaRo010522) Initial release
  - Login via `icloudjs` using the modern SRP-6a procedure (instead of the
    legacy login used by the old adapters `apple-find-me` and
    `find-my-iphone`, which no longer works)
  - Automatic trigger request so Apple actually sends the 2FA code to
    trusted devices
  - Workaround for an `icloudjs` bug where Apple answers the 2FA code
    confirmation with HTTP 409 instead of 204 for some accounts
  - 2FA code entry directly in the instance configuration (no detour via
    the object tree needed)
  - Device list including battery level, position, address (optional
    reverse geocoding via several selectable providers)
  - Per-device `showOnMap` switch for map applications (e.g. vis-2 +
    OpenStreetMap)
  - Automatic retry on truncated responses from the Apple web service

## License

MIT License

Copyright (c) 2026 KaRo010522

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
