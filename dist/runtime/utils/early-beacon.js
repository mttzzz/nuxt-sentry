import { RETRY_FAILED_KINDS, toChunkReloadBlockedEvent } from "./chunk-reload-report.js";
import { LOCAL_HOSTS } from "./sentry-enabled.js";
export const EARLY_BEACON_HEAD_KEY = "nuxt-sentry-early-beacon";
export const EARLY_BEACON_SDK_NAME = "nuxt-sentry.early-beacon";
function toScriptLiteral(value) {
  return JSON.stringify(value).replaceAll(
    /[<\u2028\u2029]/gu,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`
  );
}
function scriptSource(configLiteral) {
  return String.raw`(function (w) {
  var c = ${configLiteral};
  var nav = w.navigator;
  var loc = w.location;
  var sent = {};
  function uuid() {
    var cr = w.crypto || w.msCrypto;
    var b = [];
    var s = '';
    var i;
    if (cr && cr.getRandomValues && typeof Uint8Array === 'function') {
      b = cr.getRandomValues(new Uint8Array(16));
    } else {
      for (i = 0; i < 16; i++) {
        b[i] = Math.floor(Math.random() * 256);
      }
    }
    b[6] = (b[6] & 15) | 64;
    b[8] = (b[8] & 63) | 128;
    for (i = 0; i < 16; i++) {
      s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    }
    return s;
  }
  function noop() {}
  function clip(s, n) {
    var k;
    if (s.length <= n) {
      return s;
    }
    k = s.charCodeAt(n - 1);
    return s.slice(0, k >= 55296 && k <= 56319 ? n - 1 : n);
  }
  function text(v) {
    var j;
    if (typeof v === 'string') {
      return v;
    }
    try {
      j = JSON.stringify(v);
    } catch (e) {}
    return j === undefined ? String(v) : j;
  }
  function summary(v) {
    var m, n, k, s;
    if (v === undefined || v === null) {
      return null;
    }
    try {
      if (typeof v !== 'object') {
        return { message: clip(text(v), 2000) };
      }
      m = 'message' in v ? v.message : undefined;
      n = 'name' in v ? v.name : undefined;
      k = 'stack' in v ? v.stack : undefined;
      s = { message: clip(typeof m === 'string' ? m : text(v), 2000) };
      if (typeof n === 'string' && n !== '') {
        s.name = n;
      }
      if (typeof k === 'string' && k !== '') {
        s.stack = clip(k, 2000);
      }
      return s;
    } catch (e) {
      return null;
    }
  }
  function fill(ev, d) {
    var ch = ev.contexts.chunk;
    var er = summary(d.error);
    var t;
    if (er) {
      ch.error = er;
      t = clip(er.message.replace(/\s+/g, ' ').trim(), 200);
      if (t !== '') {
        ev.tags['chunk.error'] = t;
      }
    }
    if (typeof d.url === 'string' && d.url !== '') {
      ch.url = clip(d.url, 2000);
    }
  }
  function pick(d) {
    var i;
    var t;
    for (i = 0; i < c.events.length; i++) {
      t = c.events[i];
      if (t.reason === d.reason && (t.kind === undefined || t.kind === d.kind)) {
        return t;
      }
    }
    return null;
  }
  function send(ev, d) {
    var id = uuid();
    var ok = false;
    var body;
    try {
      fill(ev, d);
    } catch (e) {}
    ev.event_id = id;
    ev.timestamp = new Date().getTime() / 1000;
    ev.platform = 'javascript';
    ev.environment = 'production';
    if (c.release) {
      ev.release = c.release;
    }
    ev.request = { url: loc.href, headers: { 'User-Agent': nav.userAgent } };
    ev.sdk = c.sdk;
    body =
      JSON.stringify({ event_id: id, sent_at: new Date().toISOString(), dsn: c.dsn }) +
      '\n{"type":"event"}\n' +
      JSON.stringify(ev);
    try {
      ok = !!nav.sendBeacon && nav.sendBeacon(c.tunnel, body);
    } catch (e) {}
    if (!ok && w.fetch) {
      try {
        w.fetch(c.tunnel, { method: 'POST', body: body, keepalive: true }).then(noop, noop);
      } catch (e) {}
    }
  }
  if (c.skipLocalhost && c.localHosts.indexOf(loc.hostname) !== -1) {
    return;
  }
  w.addEventListener('app:chunk-reload-blocked', function (e) {
    var d = e && e.detail;
    var t = d ? pick(d) : null;
    if (!t || sent[t.reason]) {
      return;
    }
    sent[t.reason] = true;
    try {
      send(t.event, d);
    } catch (err) {}
  });
})(window);`;
}
export function buildEarlyBeaconScript(options) {
  return scriptSource(
    toScriptLiteral({
      dsn: options.dsn,
      tunnel: options.tunnelEndpoint,
      release: options.release,
      skipLocalhost: options.excludeLocalhostInProd,
      localHosts: [...LOCAL_HOSTS],
      sdk: { name: EARLY_BEACON_SDK_NAME, version: options.version },
      events: [
        {
          reason: "unsupported-browser",
          event: toChunkReloadBlockedEvent({ reason: "unsupported-browser", missing: "importmap" })
        },
        ...RETRY_FAILED_KINDS.map((kind) => ({
          reason: "retry-failed",
          kind,
          event: toChunkReloadBlockedEvent({ reason: "retry-failed", kind })
        }))
      ]
    })
  );
}
