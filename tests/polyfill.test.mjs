// De polyfill tegen het echte MIDI-blok van Lessenaar (midiIn, midiParse, midiPickInput).
// De pagina komt uit LESSENAAR_HTML (lokaal pad) of van de gepubliceerde site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const POLYFILL = readFileSync(new URL('../Lessenaar/Resources/midi-polyfill.js', import.meta.url), 'utf8');
const SITE = 'https://ricardo0h.github.io/lessenaar/';

async function pageSource() {
  if (process.env.LESSENAAR_HTML) return readFileSync(process.env.LESSENAAR_HTML, 'utf8');
  const r = await fetch(SITE);
  assert.equal(r.status, 200, 'gepubliceerde site niet bereikbaar');
  return r.text();
}
function cut(src, startMark, endMark) {
  const a = src.indexOf(startMark); assert.ok(a >= 0, 'niet gevonden: ' + startMark);
  const b = src.indexOf(endMark, a); assert.ok(b > a, 'niet gevonden: ' + endMark);
  return src.slice(a, b + endMark.length);
}
// Waarden uit de vm-context hebben andere prototypes: vergelijk als JSON.
const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);
function fn(src, name) { return cut(src, 'function ' + name + '(', '\n}\n'); }

function sandbox() {
  const sent = [];
  const ctx = {
    navigator: { userAgent: 'Mozilla/5.0 (iPad) Lessenaar-iOS', maxTouchPoints: 5 },
    webkit: { messageHandlers: { lessenaarMidi: { postMessage: m => sent.push(m) } } },
    EventTarget, Event, Uint8Array, Promise, Map, Set, setTimeout, performance,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(POLYFILL, ctx);
  return { ctx, sent, api: ctx.__lessenaarMidi };
}

test('splitMidi: losse berichten, running status, realtime en sysex', () => {
  const { api } = sandbox();
  const st = { running: 0 };
  eq(api._split([0x90, 60, 100, 0x90, 64, 90], st), [[0x90, 60, 100], [0x90, 64, 90]]);
  eq(api._split([67, 80, 60, 0], st), [[0x90, 67, 80], [0x90, 60, 0]], 'running status over pakketten');
  eq(api._split([0xfe], st), [[0xfe]]);
  eq(api._split([0xf0, 1, 2, 3, 0xf7, 0xb0, 64, 127], st), [[0xb0, 64, 127]]);
  eq(api._split([0xc0, 5, 0xd0, 9], { running: 0 }), [[0xc0, 5], [0xd0, 9]]);
  eq(api._split([0x90, 60], { running: 0 }), [], 'onvolledig bericht valt weg');
  eq(api._split([60, 100], { running: 0 }), [], 'databytes zonder status vallen weg');
});

test('zonder native brug of met echte Web MIDI doet de polyfill niets', () => {
  const ctx = { navigator: {}, EventTarget, Event }; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(POLYFILL, ctx);
  assert.equal(ctx.navigator.requestMIDIAccess, undefined);
  const own = () => 'eigen';
  const ctx2 = { navigator: { requestMIDIAccess: own }, webkit: { messageHandlers: { lessenaarMidi: { postMessage() {} } } }, EventTarget, Event };
  ctx2.window = ctx2; vm.createContext(ctx2); vm.runInContext(POLYFILL, ctx2);
  assert.equal(ctx2.navigator.requestMIDIAccess, own);
});

test('midiIn van Lessenaar: verbinden, noten ontvangen, piano eruit', async () => {
  const src = await pageSource();
  const block = cut(src, '/* MIDI-IN-BEGIN', '/* MIDI-IN-END */');
  const { ctx, sent, api } = sandbox();
  vm.runInContext(fn(src, 'midiParse') + '\n' + fn(src, 'midiPickInput') + '\n' + block + '\nglobalThis.midiIn = midiIn;', ctx);
  const midiIn = ctx.midiIn;
  assert.equal(midiIn.available(), true, 'Lessenaar ziet Web MIDI (dus geen alleen-lezen)');

  const p = midiIn.connect();
  eq(sent.at(-1), { type: 'request' });
  api.ports([{ id: -42, name: 'Port 1' }, { id: 7, name: 'Kawai ES520', manufacturer: 'KAWAI' }]);
  assert.equal(await p, 'on');
  assert.equal(midiIn.name, 'Kawai ES520');

  const got = [];
  midiIn.on(m => got.push(m));
  const before = performance.now();
  api.packet(7, [0x90, 60, 100, 60, 0, 0xfe], 1, 5);
  eq(got.map(m => [m.kind, m.n, m.v, m.ch]), [['on', 60, 100, 0], ['off', 60, 0, 0]]);
  assert.ok(got[0].t <= before && got[0].t >= before - 50, 'tijd = moment van aanslaan (leeftijd eraf)');
  eq(sent.at(-1), { type: 'ack', seq: 1, notes: 1 });

  api.packet(99, [0x90, 61, 100], 2, 0);
  assert.equal(got.length, 2, 'onbekende bron: geen bericht');
  eq(sent.at(-1), { type: 'ack', seq: 2, notes: 0 }, 'wel een ack, anders telt de meting hem als gemist');

  api.ports([{ id: -42, name: 'Port 1' }]);
  assert.equal(midiIn.status, 'on');
  assert.equal(midiIn.name, 'Port 1');
  api.ports([]);
  assert.equal(midiIn.status, 'none');
  api.ports([{ id: 7, name: 'Kawai ES520' }]);
  assert.equal(midiIn.status, 'on', 'kabel er weer in');
  api.packet(7, [0x90, 62, 80], 3, 0);
  assert.equal(got.at(-1).n, 62);
});

test('geen antwoord van native: toegang zonder bronnen', async () => {
  const { ctx } = sandbox();
  const access = await ctx.navigator.requestMIDIAccess({ sysex: false });
  assert.equal(access.inputs.size, 0);
  assert.equal(access.sysexEnabled, false);
});
