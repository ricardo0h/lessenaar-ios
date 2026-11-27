# lessenaar-ios

iOS-schil om Lessenaar (WKWebView + CoreMIDI). Proef voor `ricardo0h/piano-practice-tracker#129`; de regels en de
werkwijze staan in de `CLAUDE.md` van die repo en gelden hier ook (Nederlands, branch + PR, zelf mergen bij groene CI).

- **Deze repo is publiek.** Geen persoonlijke data: geen stuktitels, lesdata, cursusnamen, tokens of sleutels.
- `lessenaar.html` wordt hier nooit gewijzigd of gekopieerd; de schil laadt de gepubliceerde site.
- De MIDI-polyfill houdt zich aan wat het blok `midiIn` (`MIDI-IN-BEGIN/END`) gebruikt; `tests/polyfill.test.mjs`
  draait dat blok van de live site tegen de polyfill. Verandert `midiIn`, dan faalt deze test in de CI hier.
- MIDI-uit: `MIDIAccess.outputs` met `send(data, timestamp)` en `clear()` volgens de Web MIDI-spec (`tests/midi-uit.test.mjs`);
  native: bestemmingen in `MIDIBridge.swift`, berichten `send`/`clear` van de pagina.
- Scherm aan: `wake-lock.js` vervangt `navigator.wakeLock` en native zet `isIdleTimerDisabled`; `tests/wakelock.test.mjs`
  draait `requestWakeLock` van de live site ertegen.
- `testflight` draait ook elke 1e van de maand (builds verlopen na 90 dagen).
- Swift kun je in de cloud-sandbox niet bouwen: de CI (`build`) is de compiler. Een merge naar `main` gaat naar TestFlight.
