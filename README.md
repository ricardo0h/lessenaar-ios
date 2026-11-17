# lessenaar-ios

Proef: Lessenaar als iOS-app voor één gebruiker (via TestFlight), met MIDI via CoreMIDI in plaats van MIDIWeb Browser.
Besluit en criteria: issue #129 en ADR-5a in de (privé) repo `piano-practice-tracker`.

## Hoe het werkt

- Een WKWebView laadt de gepubliceerde site `https://ricardo0h.github.io/lessenaar/`. Updates van de app komen dus van
  de site zelf, zonder nieuwe build. De opslag (IndexedDB) is van deze app.
- `Lessenaar/Resources/midi-polyfill.js` geeft de pagina `navigator.requestMIDIAccess`. `MIDIBridge.swift` luistert
  met CoreMIDI naar alle bronnen en geeft de ruwe pakketten door; de polyfill splitst ze in losse berichten, zoals Web MIDI.
  `lessenaar.html` blijft ongewijzigd.
- Is er een instrument aangesloten (USB of Bluetooth), dan geeft de brug alleen dat door. De netwerksessie van iOS en
  virtuele poorten van andere apps (zoals `MIDIWeb Out`) alleen als er niets anders is.
- Meetscherm voor criterium (a): **houd drie vingers ongeveer een seconde op het scherm**. Het toont de vertraging van
  het MIDI-pakket in iOS tot de app de noot heeft verwerkt (mediaan, p95, max) en hoeveel pakketten er gemist zijn.
- Geen service worker en geen offline start (bonus, geen eis). Zonder wifi zie je "Lessenaar laadt niet" en een knop Opnieuw.

## Tijdens de proef: niet naar de data-repo schrijven

Na een herstel van sync heeft de schil dezelfde `libraryId` als MIDIWeb Browser. Schrijven ze allebei, dan overschrijven ze
elkaars `backup/lessenaar.json` zonder waarschuwing (ADR-5a). Daarom tijdens de proef:

- in de schil een fine-grained token met alleen **Contents: Read-only** op de data-repo: herstel werkt, schrijven niet
  (dat staat dan rood bij Sync, en dat is goed zo);
- Melden (de vlag) schrijft ook naar de data-repo en lukt in de schil dus niet; meld iets over de schil vanuit MIDIWeb Browser;
- in de schil geen sessie afronden (anders komt hij in `sessies/` en schrijft de coach er een plan op).

## Bouwen

Er is geen Mac nodig. `.github/workflows/ios.yml`:

1. `polyfill` (Linux): `node --test tests/*.test.mjs`, tegen het MIDI-blok van de gepubliceerde site.
2. `build` (macOS): `xcodegen generate` en een simulatorbuild zonder ondertekenen. Draait bij elke PR.
3. `testflight` (macOS, alleen op `main` en met de hand): registreert de bundle-id, archiveert met automatisch
   ondertekenen via de App Store Connect API-sleutel en uploadt naar TestFlight.

De API-sleutel moet de rol **Admin** hebben: archiveren maakt op een schone runner zelf certificaten aan, en de export
gebruikt een door Apple beheerd distributiecertificaat. Alleen iPad (`TARGETED_DEVICE_FAMILY` 2): op de iPhone zou de
polyfill de alleen-lezen-guard van Lessenaar omzeilen.

Secrets: `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`. Optioneel de variabele `APPLE_TEAM_ID`; zonder die komt de team-id uit
App Store Connect (`seedId` van de bundle-id).

Lokaal testen van de polyfill tegen een eigen kopie van de pagina:
`LESSENAAR_HTML=../piano-practice-tracker/piano_practice/web/lessenaar.html node --test tests/*.test.mjs`
