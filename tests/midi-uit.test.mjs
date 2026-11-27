// MIDI-uit in de polyfill: MIDIAccess.outputs, MIDIOutput.send/clear en statechange, volgens de Web MIDI-spec.
// Plus: het blok midiIn van de gepubliceerde Lessenaar blijft werken als er ook bestemmingen zijn.
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
function fn(src, name) { return cut(src, 'function ' + name + '(', '\n}\n'); }
const eq = (a, b, msg) => assert.deepEqual(JSON.parse(JSON.stringify(a)), b, msg);

// clock: een vaste performance.now(), zodat delay exact te controleren is.
function sandbox() {
  const sent = [];
  const clock = { t: 1000 };
  const ctx = {
    navigator: { userAgent: 'Mozilla/5.0 (iPad) Lessenaar-iOS', maxTouchPoints: 5 },
    webkit: { messageHandlers: { lessenaarMidi: { postMessage: m => sent.push(m) } } },
    performance: { now: () => clock.t },
    EventTarget, Event, DOMException, Uint8Array, Promise, Map, Set, setTimeout,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(POLYFILL, ctx);
  const sends = () => sent.filter(m => m.type === 'send' || m.type === 'clear');
  return { ctx, sent, sends, clock, api: ctx.__lessenaarMidi };
}
const PIANO = { id: 7, name: 'Kawai ES520', manufacturer: 'KAWAI' };

async function access(s, ins = [PIANO], outs = [PIANO]) {
  const p = s.ctx.navigator.requestMIDIAccess({ sysex: false });
  s.api.ports(ins, outs);
  return p;
}

test('outputs: bestemmingen verschijnen als MIDIOutput', async () => {
  const s = sandbox();
  const a = await access(s, [PIANO], [PIANO, { id: -3, name: 'Netwerk' }]);
  assert.equal(a.outputs.size, 2);
  const out = a.outputs.get('7');
  eq({ id: out.id, name: out.name, manufacturer: out.manufacturer, type: out.type, state: out.state, connection: out.connection },
    { id: '7', name: 'Kawai ES520', manufacturer: 'KAWAI', type: 'output', state: 'connected', connection: 'open' });
  assert.equal(typeof out.send, 'function');
  assert.equal(typeof out.clear, 'function');
  assert.equal(await out.open(), out);
  assert.equal(a.inputs.get('7').type, 'input', 'invoer en uitvoer met dezelfde id staan los van elkaar');
});

test('outputs: statechange bij aansluiten en loskoppelen, hetzelfde object bij terugkomst', async () => {
  const s = sandbox();
  const a = await access(s, [PIANO], []);
  assert.equal(a.outputs.size, 0);
  const events = [];
  a.onstatechange = e => events.push(['access', e.port.type, e.port.id, e.port.state]);
  a.addEventListener('statechange', e => events.push(['listener', e.port.type, e.port.id, e.port.state]));

  s.api.ports([PIANO], [PIANO]);
  eq(events, [['access', 'output', '7', 'connected'], ['listener', 'output', '7', 'connected']]);
  const out = a.outputs.get('7');
  const own = [];
  out.onstatechange = e => own.push(e.port.state);

  events.length = 0;
  s.api.ports([PIANO], [PIANO]);
  eq(events, [], 'niets veranderd: geen event');

  s.api.ports([PIANO], []);
  assert.equal(a.outputs.size, 0);
  assert.equal(out.state, 'disconnected');
  assert.equal(out.connection, 'closed');
  eq(own, ['disconnected']);
  eq(events.map(e => e.slice(1)), [['output', '7', 'disconnected'], ['output', '7', 'disconnected']]);
  assert.throws(() => out.send([0x90, 60, 100]), e => e.name === 'InvalidStateError');

  s.api.ports([PIANO], [PIANO]);
  assert.equal(a.outputs.get('7'), out, 'kabel er weer in: zelfde MIDIOutput (spec)');
  assert.equal(out.state, 'connected');
  eq(own, ['disconnected', 'connected']);
  out.send([0x90, 60, 100]);
  eq(s.sends().at(-1), { type: 'send', id: '7', data: [0x90, 60, 100], delay: 0 });
});

test('ports zonder bestemmingen laat outputs staan (alleen bronnen bijwerken)', async () => {
  const s = sandbox();
  const a = await access(s);
  s.api.ports([]);
  assert.equal(a.inputs.size, 0);
  assert.equal(a.outputs.size, 1);
});

test('send: juiste bytes in de juiste volgorde naar native', async () => {
  const s = sandbox();
  const out = (await access(s)).outputs.get('7');
  out.send([0x90, 60, 100]);
  out.send(new Uint8Array([0x90, 64, 90, 0x90, 67, 80]));   // akkoord in één aanroep
  out.send([0xb0, 64, 127]);
  out.send([0x80, 60, 0]);
  out.send([0xc0, 5]);
  out.send([0xf8]);
  out.send([]);                                            // leeg: niets versturen
  eq(s.sends(), [
    { type: 'send', id: '7', data: [0x90, 60, 100], delay: 0 },
    { type: 'send', id: '7', data: [0x90, 64, 90, 0x90, 67, 80], delay: 0 },
    { type: 'send', id: '7', data: [0xb0, 64, 127], delay: 0 },
    { type: 'send', id: '7', data: [0x80, 60, 0], delay: 0 },
    { type: 'send', id: '7', data: [0xc0, 5], delay: 0 },
    { type: 'send', id: '7', data: [0xf8], delay: 0 },
  ]);
});

test('send met timestamp: toekomst wordt een vertraging, verleden en 0 meteen', async () => {
  const s = sandbox();
  const out = (await access(s)).outputs.get('7');
  s.clock.t = 5000;
  out.send([0x90, 60, 100], 5250);
  out.send([0x80, 60, 0], 5750.5);
  out.send([0x90, 62, 100], 4000);      // voorbij
  out.send([0x90, 63, 100], 0);
  out.send([0x90, 64, 100], undefined);
  eq(s.sends().map(m => m.delay), [250, 750.5, 0, 0, 0]);
  eq(s.sends().map(m => m.data[1]), [60, 60, 62, 63, 64], 'volgorde van aanroepen blijft, ook met tijdstempels');
});

test('send: ongeldige data geeft de fouten uit de spec en verstuurt niets', async () => {
  const s = sandbox();
  const out = (await access(s)).outputs.get('7');
  const typeError = e => e instanceof TypeError || e.name === 'TypeError';
  assert.throws(() => out.send([60, 100]), typeError, 'databytes zonder status (geen running status)');
  assert.throws(() => out.send([0x90, 60]), typeError, 'onvolledig bericht');
  assert.throws(() => out.send([0x90, 60, 100, 64, 90]), typeError, 'running status mag niet bij send');
  assert.throws(() => out.send([0x90, 60, 200]), typeError, 'statusbyte waar een databyte hoort');
  assert.throws(() => out.send([256]), typeError);
  assert.throws(() => out.send(null), typeError);
  assert.throws(() => out.send([0xf0, 1, 2, 0xf7]), e => e.name === 'InvalidAccessError', 'sysex staat uit');
  eq(s.sends(), []);
});

test('clear: naar native voor die bestemming', async () => {
  const s = sandbox();
  const out = (await access(s)).outputs.get('7');
  out.send([0x90, 60, 100], 2000);
  out.clear();
  eq(s.sends().at(-1), { type: 'clear', id: '7' });
});

test('midiIn van Lessenaar met bestemmingen erbij: invoer ongewijzigd', async () => {
  const src = await pageSource();
  const block = cut(src, '/* MIDI-IN-BEGIN', '/* MIDI-IN-END */');
  const s = sandbox();
  vm.runInContext(fn(src, 'midiParse') + '\n' + fn(src, 'midiPickInput') + '\n' + block + '\nglobalThis.midiIn = midiIn;', s.ctx);
  const midiIn = s.ctx.midiIn;
  const p = midiIn.connect();
  s.api.ports([{ id: -42, name: 'Port 1' }, PIANO], [PIANO, { id: -3, name: 'Netwerk' }]);
  assert.equal(await p, 'on');
  assert.equal(midiIn.name, 'Kawai ES520');
  const got = [];
  midiIn.on(m => got.push(m));
  s.api.packet(7, [0x90, 60, 100], 1, 0);
  eq(got.map(m => [m.kind, m.n]), [['on', 60]]);

  s.api.ports([{ id: -42, name: 'Port 1' }, PIANO], []);   // alleen de bestemmingen weg: statechange voor outputs
  assert.equal(midiIn.status, 'on');
  assert.equal(midiIn.name, 'Kawai ES520');
  s.api.packet(7, [0x90, 62, 100], 2, 0);
  assert.equal(got.at(-1).n, 62, 'noten komen nog binnen');
  assert.equal(midiIn.access.outputs.size, 0);
});
