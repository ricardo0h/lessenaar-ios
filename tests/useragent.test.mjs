// Kenmerk van de schil in de user agent (#127, ADR-8): `Lessenaar-iOS/<versie> (iPhone)` of `(iPad)`.
// De webapp leest precies dit kenmerk om de iPhone als tweede apparaat (alleen sessies) te behandelen.
// Swift kan hier niet draaien: de test leest userAgentMark() uit WebViewController.swift en bouwt de string na zoals
// WKWebView hem achter de standaard-UA zet. Daarna draaien de bestaande UA-functies van de live site ertegen,
// zodat het nieuwe kenmerk niets breekt wat al op `Lessenaar-iOS/` leunt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SWIFT = readFileSync(new URL('../Lessenaar/WebViewController.swift', import.meta.url), 'utf8');
const PROJECT = readFileSync(new URL('../project.yml', import.meta.url), 'utf8');
const SITE = 'https://ricardo0h.github.io/lessenaar/';

// De afspraak met de webkant. Versie = CFBundleShortVersionString (geen spaties).
const MARK = /\bLessenaar-iOS\/([0-9][0-9A-Za-z.]*) \((iPhone|iPad)\)$/;

async function pageSource() {
  if (process.env.LESSENAAR_HTML) return readFileSync(process.env.LESSENAAR_HTML, 'utf8');
  const r = await fetch(SITE);
  assert.equal(r.status, 200, 'gepubliceerde site niet bereikbaar');
  return r.text();
}
function fn(src, name) {
  const a = src.indexOf('function ' + name + '(');
  assert.ok(a >= 0, 'niet gevonden in Lessenaar: function ' + name);
  return src.slice(a, src.indexOf('\n}\n', a) + 2);
}

// userAgentMark() uit de Swift-bron, nagebouwd voor een apparaat en een versie.
function swiftMark(idiom, version) {
  const a = SWIFT.indexOf('static func userAgentMark() -> String {');
  assert.ok(a >= 0, 'userAgentMark() niet gevonden in WebViewController.swift');
  const body = SWIFT.slice(a, SWIFT.indexOf('\n    }\n', a));
  assert.match(body, /forInfoDictionaryKey: "CFBundleShortVersionString"\) as\? String \?\? "0"/, 'versie uit CFBundleShortVersionString');
  const dev = body.match(/let device = UIDevice\.current\.userInterfaceIdiom == \.phone \? "(\w+)" : "(\w+)"/);
  assert.ok(dev, 'apparaat uit userInterfaceIdiom (.phone → iPhone, anders iPad)');
  const ret = body.match(/return (.+)/);
  assert.ok(ret, 'return-regel');
  // Alleen letterlijke strings en de variabelen version/device, aan elkaar met +.
  const parts = ret[1].split(' + ').map(p => p.trim());
  const device = idiom === 'phone' ? dev[1] : dev[2];
  return parts.map(p => {
    if (p === 'version') return version;
    if (p === 'device') return device;
    const lit = p.match(/^"([^"\\]*)"$/);
    assert.ok(lit, 'onverwacht deel in de return van userAgentMark: ' + p);
    return lit[1];
  }).join('');
}
// Zo zet WKWebView applicationNameForUserAgent achter de standaard-UA (iPhone: mobiel; iPad: desktop-modus, "Macintosh").
// applicationNameForUserAgent vervangt de standaardnaam (`Mobile/15E148` op de iPhone), dus die staat er niet meer in.
const UA = {
  phone: m => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) ' + m,
  pad: m => 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' + m,
};

test('kenmerk: Lessenaar-iOS/<versie> (iPhone) en (iPad)', () => {
  assert.equal(swiftMark('phone', '0.1'), 'Lessenaar-iOS/0.1 (iPhone)');
  assert.equal(swiftMark('pad', '0.1'), 'Lessenaar-iOS/0.1 (iPad)');
  assert.equal(swiftMark('pad', '12.3'), 'Lessenaar-iOS/12.3 (iPad)');
  for (const idiom of ['phone', 'pad']) {
    const ua = UA[idiom](swiftMark(idiom, '0.1'));
    const m = ua.match(MARK);
    assert.ok(m, 'afspraak herkent ' + ua);
    assert.deepEqual([m[1], m[2]], ['0.1', idiom === 'phone' ? 'iPhone' : 'iPad']);
  }
  assert.match(SWIFT, /config\.applicationNameForUserAgent = Self\.userAgentMark\(\)/, 'de webview gebruikt het kenmerk');
});

test('project: iPhone en iPad in het doel, iPhone zonder ondersteboven', () => {
  assert.match(PROJECT, /TARGETED_DEVICE_FAMILY: "1,2"/);
  const phone = PROJECT.match(/UISupportedInterfaceOrientations:\n((?:\s+- \w+\n)+)/);
  assert.ok(phone, 'oriëntaties voor de iPhone');
  assert.deepEqual(phone[1].trim().split(/\s*-\s*/).filter(Boolean),
    ['UIInterfaceOrientationPortrait', 'UIInterfaceOrientationLandscapeLeft', 'UIInterfaceOrientationLandscapeRight']);
});

test('live site: wat al op Lessenaar-iOS/ en het apparaat leunt, blijft werken', async () => {
  const src = await pageSource();
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(fn(src, 'writerLabel') + '\n' + fn(src, 'appleMobile') + '\n' +
    'globalThis.writerLabel = writerLabel; globalThis.appleMobile = appleMobile;', ctx);
  for (const idiom of ['phone', 'pad']) {
    const ua = UA[idiom](swiftMark(idiom, '0.1'));
    assert.equal(ctx.writerLabel(ua, 5), 'de Lessenaar-app', ua);
    assert.equal(ctx.appleMobile({ ua, touch: 5 }), true, 'nog steeds een Apple-toestel: ' + ua);
  }
});
