// wake-lock.js (scherm aan in de schil) tegen requestWakeLock van Lessenaar.
// De pagina komt uit LESSENAAR_HTML (lokaal pad) of van de gepubliceerde site.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const SCRIPT = readFileSync(new URL('../Lessenaar/Resources/wake-lock.js', import.meta.url), 'utf8');
const SITE = 'https://ricardo0h.github.io/lessenaar/';

async function pageSource() {
  if (process.env.LESSENAAR_HTML) return readFileSync(process.env.LESSENAAR_HTML, 'utf8');
  const r = await fetch(SITE);
  assert.equal(r.status, 200, 'gepubliceerde site niet bereikbaar');
  return r.text();
}
function fn(src, name) {
  const start = src.search(new RegExp('(async )?function ' + name + '\\('));
  assert.ok(start >= 0, 'niet gevonden in Lessenaar: function ' + name);
  return src.slice(start, src.indexOf('\n}\n', start) + 2);
}

function sandbox() {
  const sent = [];
  const document = new EventTarget();
  document.visibilityState = 'visible';
  const ctx = {
    navigator: { userAgent: 'Mozilla/5.0 (iPad) Lessenaar-iOS' },
    webkit: { messageHandlers: { lessenaarWake: { postMessage: m => sent.push(m) } } },
    document, EventTarget, Event, DOMException, Promise, Set,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  const hide = state => { document.visibilityState = state; document.dispatchEvent(new Event('visibilitychange')); };
  return { ctx, sent, hide, api: ctx.__lessenaarWake };
}
// Native houdt per id bij of er een lock is: zo rekent WebViewController ook.
function screenOn(sent) {
  const on = new Set();
  for (const m of sent) if (m.type === 'wake') (m.on ? on.add(m.id) : on.delete(m.id));
  return on.size > 0;
}

test('zonder native brug doet het script niets', () => {
  const own = { request: () => 'eigen' };
  const ctx = { navigator: { wakeLock: own }, EventTarget, Event }; ctx.window = ctx; vm.createContext(ctx);
  vm.runInContext(SCRIPT, ctx);
  assert.equal(ctx.navigator.wakeLock, own);
});

test('request en release: scherm aan en weer uit, met release-event', async () => {
  const { ctx, sent } = sandbox();
  const lock = await ctx.navigator.wakeLock.request('screen');
  assert.equal(lock.type, 'screen');
  assert.equal(lock.released, false);
  assert.equal(screenOn(sent), true);
  let events = 0;
  lock.addEventListener('release', () => events++);
  lock.onrelease = () => events++;
  await lock.release();
  assert.equal(lock.released, true);
  assert.equal(events, 2);
  assert.equal(screenOn(sent), false);
  await lock.release();
  assert.equal(events, 2, 'twee keer loslaten: één event');
  assert.equal(sent.length, 2, 'en één bericht naar native');
});

test('twee locks: het scherm blijft aan tot de laatste los is', async () => {
  const { ctx, sent } = sandbox();
  const a = await ctx.navigator.wakeLock.request('screen');
  const b = await ctx.navigator.wakeLock.request();
  await a.release();
  assert.equal(screenOn(sent), true);
  await b.release();
  assert.equal(screenOn(sent), false);
});

test('naar de achtergrond: alles los; verborgen pagina krijgt geen lock', async () => {
  const { ctx, sent, hide, api } = sandbox();
  const lock = await ctx.navigator.wakeLock.request('screen');
  hide('hidden');
  assert.equal(lock.released, true);
  assert.equal(api.held(), 0);
  assert.equal(screenOn(sent), false);
  await assert.rejects(ctx.navigator.wakeLock.request('screen'), { name: 'NotAllowedError' });
  await assert.rejects(ctx.navigator.wakeLock.request('cpu'), { name: 'TypeError' });
});

test('requestWakeLock van Lessenaar: lezer open = scherm aan, terug uit de achtergrond = opnieuw aan', async () => {
  const src = await pageSource();
  const { ctx, sent, hide } = sandbox();
  vm.runInContext(fn(src, 'requestWakeLock') + '\nglobalThis.requestWakeLock = requestWakeLock; globalThis.R = { wake: null };', ctx);
  await ctx.requestWakeLock();
  assert.ok(ctx.R.wake, 'Lessenaar houdt de lock vast');
  assert.equal(screenOn(sent), true);

  hide('hidden');
  assert.equal(ctx.R.wake, null, 'het release-event zet R.wake op null, zoals in de browser');
  assert.equal(screenOn(sent), false);

  hide('visible');
  await ctx.requestWakeLock();   // wat Lessenaar doet bij visibilitychange als de lezer open is
  assert.equal(screenOn(sent), true);

  // closeReader: R.wake.release().catch(...)
  await ctx.R.wake.release().catch(() => {});
  assert.equal(screenOn(sent), false);
});
