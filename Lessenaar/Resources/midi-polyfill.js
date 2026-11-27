/* Web MIDI-polyfill voor Lessenaar in de iOS-schil (proef, piano-practice-tracker#129).
   De pagina ziet gewoon navigator.requestMIDIAccess; de native kant (MIDIBridge.swift via WebViewController.swift)
   roept window.__lessenaarMidi.ports(bronnen, bestemmingen) en .packet(bronId, bytes, seq, leeftijdMs) aan.
   Berichten naar native: { type: 'request' }, { type: 'ack', seq, notes },
   { type: 'send', id, data: [bytes], delay: ms } (MIDI-uit; delay 0 = meteen) en { type: 'clear', id }. */
(function (root) {
  'use strict';
  const nav = root.navigator;
  const wk = root.webkit && root.webkit.messageHandlers && root.webkit.messageHandlers.lessenaarMidi;
  if (!nav || nav.requestMIDIAccess || !wk) return;
  const post = m => { try { wk.postMessage(m); } catch (e) { /* native weg: niets te doen */ } };
  const now = () => (root.performance && root.performance.now ? root.performance.now() : Date.now());

  // Lengte van een MIDI-bericht inclusief statusbyte.
  function msgLen(s) {
    const hi = s & 0xf0;
    if (hi === 0xc0 || hi === 0xd0) return 2;
    if (s < 0xf0) return 3;
    if (s === 0xf1 || s === 0xf3) return 2;
    if (s === 0xf2) return 3;
    return 1;
  }
  // Ruwe CoreMIDI-pakketbytes → losse berichten, zoals Web MIDI ze per event levert.
  // Running status loopt door over pakketten (st per bron); realtime (F8–FF) los; sysex overgeslagen (sysex: false);
  // een onvolledig bericht aan het eind valt weg.
  function splitMidi(bytes, st) {
    const out = [], n = bytes.length;
    let i = 0;
    while (i < n) {
      const b = bytes[i];
      if (b >= 0xf8) { out.push([b]); i++; continue; }
      if (b === 0xf0) { while (i < n && bytes[i] !== 0xf7) i++; i++; st.running = 0; continue; }
      let status, start;
      if (b >= 0x80) { status = b; start = i + 1; st.running = b < 0xf0 ? b : 0; }
      else if (st.running) { status = st.running; start = i; }
      else { i++; continue; }
      const need = msgLen(status) - 1, msg = [status];
      let j = start;
      while (msg.length - 1 < need && j < n && bytes[j] < 0x80) msg.push(bytes[j++]);
      if (msg.length - 1 === need) out.push(msg);
      i = j;
    }
    return out;
  }

  const access = new EventTarget();
  access.inputs = new Map();
  access.outputs = new Map();
  access.sysexEnabled = false;
  access.onstatechange = null;
  const running = new Map();   // bron-id → { running }

  function makeInput(p) {
    const port = new EventTarget();
    Object.assign(port, {
      id: String(p.id), name: p.name || '', manufacturer: p.manufacturer || '', version: '',
      type: 'input', state: 'connected', connection: 'open', onmidimessage: null, onstatechange: null,
    });
    port.open = () => Promise.resolve(port);
    port.close = () => Promise.resolve(port);
    return port;
  }
  // Web MIDI-spec, MIDIOutput.send: één of meer volledige berichten, geen running status; sysex alleen met sysexEnabled.
  function error(name, message) {
    if (typeof root.DOMException === 'function') return new root.DOMException(message, name);
    const e = new Error(message); e.name = name; return e;
  }
  function checkSend(data) {
    if (data == null || typeof data[Symbol.iterator] !== 'function') throw new TypeError('send: data is geen reeks bytes');
    const bytes = [];
    for (const v of data) {
      const b = Number(v);
      if (!Number.isInteger(b) || b < 0 || b > 255) throw new TypeError('send: ' + v + ' is geen byte');
      bytes.push(b);
    }
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      if (b === 0xf0) throw error('InvalidAccessError', 'send: sysex staat uit');
      if (b < 0x80 || b === 0xf7) throw new TypeError('send: databyte zonder status op positie ' + i);
      const n = msgLen(b);
      for (let k = 1; k < n; k++) {
        if (i + k >= bytes.length || bytes[i + k] >= 0x80) throw new TypeError('send: onvolledig bericht op positie ' + i);
      }
      i += n;
    }
    return bytes;
  }
  function makeOutput(p) {
    const port = new EventTarget();
    Object.assign(port, {
      id: String(p.id), name: p.name || '', manufacturer: p.manufacturer || '', version: '',
      type: 'output', state: 'connected', connection: 'open', onstatechange: null,
    });
    port.open = () => (port.state === 'disconnected'
      ? Promise.reject(error('InvalidAccessError', 'poort is losgekoppeld')) : Promise.resolve(port));
    port.close = () => Promise.resolve(port);
    // timestamp in de tijd van performance.now(); leeg, 0 of voorbij = meteen. Native plant het met CoreMIDI in.
    port.send = (data, timestamp) => {
      if (port.state === 'disconnected') throw error('InvalidStateError', 'poort is losgekoppeld');
      const bytes = checkSend(data);
      if (!bytes.length) return;
      const ts = Number(timestamp) || 0;
      const delay = ts > 0 ? Math.max(0, ts - now()) : 0;
      post({ type: 'send', id: port.id, data: bytes, delay });
    };
    port.clear = () => { post({ type: 'clear', id: port.id }); };
    return port;
  }
  const outputsSeen = new Map();   // bestemming-id → poort: komt een bestemming terug, dan hetzelfde object (spec)

  function stateChange(port) {
    const ev = new Event('statechange');
    Object.defineProperty(ev, 'port', { value: port });
    if (typeof port.onstatechange === 'function') port.onstatechange(ev);
    if (typeof access.onstatechange === 'function') access.onstatechange(ev);
    access.dispatchEvent(ev);
  }

  const waiting = [];   // resolves van lopende requestMIDIAccess-aanroepen
  const api = {
    // Native → JS: de huidige bronnen en bestemmingen. Bestaande poorten houden hun object (en dus hun onmidimessage).
    // Zonder tweede argument blijven de bestemmingen zoals ze zijn.
    ports(list, outList) {
      const seen = new Set(), changed = [];
      for (const p of list || []) {
        const id = String(p.id); seen.add(id);
        if (!access.inputs.has(id)) { const port = makeInput(p); access.inputs.set(id, port); changed.push(port); }
      }
      for (const [id, port] of [...access.inputs]) {
        if (!seen.has(id)) { access.inputs.delete(id); running.delete(id); port.state = 'disconnected'; port.connection = 'closed'; changed.push(port); }
      }
      if (Array.isArray(outList)) {
        const outSeen = new Set();
        for (const p of outList) {
          const id = String(p.id); outSeen.add(id);
          if (access.outputs.has(id)) continue;
          let port = outputsSeen.get(id);
          if (port) { port.state = 'connected'; port.connection = 'open'; }
          else { port = makeOutput(p); outputsSeen.set(id, port); }
          access.outputs.set(id, port); changed.push(port);
        }
        for (const [id, port] of [...access.outputs]) {
          if (!outSeen.has(id)) { access.outputs.delete(id); port.state = 'disconnected'; port.connection = 'closed'; changed.push(port); }
        }
      }
      for (const r of waiting.splice(0)) r(access);
      for (const port of changed) stateChange(port);
    },
    // Native → JS: één CoreMIDI-pakket van een bron. Altijd een ack terug (ook zonder poort), zodat de meting klopt.
    packet(id, bytes, seq, ageMs) {
      const key = String(id), port = access.inputs.get(key);
      let notes = 0;
      if (port) {
        if (!running.has(key)) running.set(key, { running: 0 });
        const t = now() - (ageMs > 0 ? ageMs : 0);
        for (const msg of splitMidi(bytes || [], running.get(key))) {
          if (msg[0] === 0xfe || msg[0] === 0xf8) continue;   // active sensing en clock: de app doet er niets mee
          if ((msg[0] & 0xf0) === 0x90 && msg[2] > 0) notes++;
          const ev = new Event('midimessage');
          Object.defineProperty(ev, 'data', { value: new Uint8Array(msg) });
          Object.defineProperty(ev, 'timeStamp', { value: t });
          if (typeof port.onmidimessage === 'function') port.onmidimessage(ev);
          port.dispatchEvent(ev);
        }
      }
      if (seq) post({ type: 'ack', seq, notes });
    },
    _split: splitMidi,
  };
  Object.defineProperty(root, '__lessenaarMidi', { value: api });

  nav.requestMIDIAccess = function () {
    return new Promise(resolve => {
      waiting.push(resolve);
      post({ type: 'request' });
      // Geen antwoord van native: toch toegang, zonder bronnen (de app toont dan "geen piano").
      setTimeout(() => { const i = waiting.indexOf(resolve); if (i >= 0) { waiting.splice(i, 1); resolve(access); } }, 1500);
    });
  };
})(typeof window !== 'undefined' ? window : globalThis);
