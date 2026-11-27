# lessenaar-ios

Lessenaar als iOS-app voor de iPad en de iPhone (via TestFlight), met MIDI via CoreMIDI. Deze app vervangt MIDIWeb Browser als de
plek waar Lessenaar draait. Besluit en overstap: issue #183 in de (privé) repo `piano-practice-tracker`.

Tot het omzetten na 1 dec (#183) staat in de app nog het lees-token, dus Sync, Melden en Afronden schrijven nog niet naar de data-repo.

## Hoe het werkt

- Een WKWebView laadt de gepubliceerde site `https://ricardo0h.github.io/lessenaar/`. Updates van de app komen dus van
  de site zelf, zonder nieuwe build. De opslag (IndexedDB) is van deze app en hangt aan die URL.
- `Lessenaar/Resources/midi-polyfill.js` geeft de pagina `navigator.requestMIDIAccess`. `MIDIBridge.swift` luistert
  met CoreMIDI naar alle bronnen en geeft de ruwe pakketten door; de polyfill splitst ze in losse berichten, zoals Web MIDI.
  `lessenaar.html` blijft ongewijzigd.
- Is er een instrument aangesloten (USB of Bluetooth), dan geeft de brug alleen dat door. De netwerksessie van iOS en
  virtuele poorten van andere apps (zoals `MIDIWeb Out`) alleen als er niets anders is.
- **MIDI-uit:** de bestemmingen staan als `MIDIAccess.outputs` in de pagina, met dezelfde voorkeur (een echt instrument
  gaat voor). `output.send(data, timestamp)` en `output.clear()` werken zoals Web MIDI in een browser: `timestamp` in de
  tijd van `performance.now()`, leeg of voorbij is meteen; de brug plant het in met de tijdstempel van CoreMIDI. Sysex
  staat uit. Gaat de pagina weg of de app naar de achtergrond, dan stopt wat nog ingepland stond en gaan alle noten uit.
- **Scherm aan:** `Lessenaar/Resources/wake-lock.js` vervangt `navigator.wakeLock`. Vraagt de pagina een lock (bij het
  openen van de lezer), dan zet de app `isIdleTimerDisabled`; bij loslaten, sluiten van de lezer of naar de achtergrond
  weer uit. Zo werkt het op elke iOS-versie, ook waar de wake lock van WKWebView het scherm niet aan houdt.
- Meetscherm: **houd drie vingers ongeveer een seconde op het scherm**. Het toont de vertraging van het MIDI-pakket in
  iOS tot de app de noot heeft verwerkt (mediaan, p95, max), hoeveel pakketten er gemist zijn, de bronnen, de
  bestemmingen (MIDI-uit), en of het scherm nu aan blijft. De knop **Testnoot** speelt de middelste C kort op elke bestemming.
- Geen service worker en geen offline start. Zonder wifi zie je "Lessenaar laadt niet" en een knop Opnieuw.
- **iPad en iPhone** (`TARGETED_DEVICE_FAMILY` 1,2). De iPad is het thuis van de data; de iPhone is een tweede apparaat
  dat alleen sessies en meldingen toevoegt (ADR-8, #127 in `piano-practice-tracker`). Dat regelt de webapp, niet de schil.
- **Kenmerk in de user agent:** de schil zet `Lessenaar-iOS/<versie> (iPhone)` of `Lessenaar-iOS/<versie> (iPad)` achter
  de user agent (`WebViewController.userAgentMark`, versie = `CFBundleShortVersionString`). Op de iPad is de rest van de
  UA die van desktop-Safari ("Macintosh"), dus het apparaat staat er expliciet in. De webapp leest dit kenmerk om de
  iPhone als tweede apparaat te behandelen (`deviceRole` → `toevoeger`); `tests/useragent.test.mjs` bewaakt het formaat
  en draait `writerLabel`, `appleMobile` en `deviceRole` van de live site ertegen. Zonder die rol op de site is de CI rood. Niet veranderen zonder de webkant.
- **iPhone-scherm:** staand en liggend (niet ondersteboven). Boven en onder loopt de pagina door tot de rand en regelt
  ze de safe area zelf (`viewport-fit=cover`); links en rechts houdt de schil de safe area vrij, zodat de notch of het
  Dynamic Island in liggende stand niet over de pagina valt. Het meetscherm (drie vingers) werkt ook op de iPhone.

## Bouwen

Er is geen Mac nodig. `.github/workflows/ios.yml`:

1. `polyfill` (Linux): `node --test tests/*.test.mjs`, tegen de gepubliceerde site (het MIDI-blok, `requestWakeLock` en
   de UA-functies), plus MIDI-uit (`tests/midi-uit.test.mjs`) en het kenmerk in de user agent (`tests/useragent.test.mjs`).
2. `build` (macOS): `xcodegen generate` en een simulatorbuild zonder ondertekenen. Draait bij elke PR.
3. `testflight` (macOS): bij elke merge naar `main`, met de hand, en **elke 1e van de maand** (TestFlight-builds
   verlopen na 90 dagen). Registreert de bundle-id, archiveert met automatisch ondertekenen via de App Store
   Connect API-sleutel en uploadt naar TestFlight. Buildnummer: `<run>.<poging>` van de workflow.

GitHub zet de maandbuild uit na 60 dagen zonder commits in deze repo; je krijgt dan een mail. Weer aanzetten:
Actions → iOS → **Enable workflow**, en daarna **Run workflow** op `main` voor een verse build.

De API-sleutel moet de rol **Admin** hebben: archiveren maakt op een schone runner zelf certificaten aan, en de export
gebruikt een door Apple beheerd distributiecertificaat.

Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`. Optioneel de variabele `APPLE_TEAM_ID`; zonder die komt de team-id uit
App Store Connect (`seedId` van de bundle-id).

Lokaal testen tegen een eigen kopie van de pagina:
`LESSENAAR_HTML=../piano-practice-tracker/piano_practice/web/lessenaar.html node --test tests/*.test.mjs`
