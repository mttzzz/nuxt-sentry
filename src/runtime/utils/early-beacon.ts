import { RETRY_FAILED_KINDS, toChunkReloadBlockedEvent } from './chunk-reload-report'
import {
  LOAD_TIMEOUT_FINGERPRINT,
  LOAD_TIMEOUT_HOST_UNKNOWN,
  LOAD_TIMEOUT_LEVEL,
  LOAD_TIMEOUT_MESSAGE_BOOT,
  LOAD_TIMEOUT_MESSAGE_GENERIC,
  LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX,
  LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX,
  LOAD_TIMEOUT_MESSAGE_PREFIX,
  LOAD_TIMEOUT_MESSAGE_SUFFIX,
} from './load-timeout-report'
import { LOCAL_HOSTS } from './sentry-enabled'

/*
 * Ранний beacon — inline-скрипт в <head>, которому не нужен SDK. Он слушает `app:chunk-reload-blocked`
 * stale-deploy-guard и сам, без SDK, отправляет envelope в tunnel для двух исходов, при которых клиентский
 * Sentry.init не выполняется вовсе или ещё не успел выполниться:
 *
 * - `unsupported-browser`. Nuxt 4.1+ кладёт entry в `<script type="importmap">` под ключом `#entry`; в
 *   WebKit без import maps (iOS < 16.4) импорт падает, приложение не стартует и ни одно событие
 *   (ai.pushka.biz, 15.10.2026: iPhone на iOS 16.0.2, `500 Module specifier '#entry' …`) не может уйти
 *   штатным путём. stale-deploy-guard (≥ 0.5.1) ловит такой браузер inline-скриптом в bodyClose, зовёт
 *   window.stop() и сразу после него диспатчит событие. Этот скрипт стоит в head — раньше bodyClose-скрипта guard.
 * - `retry-failed` (guard ≥ 0.6.0): страница не загрузилась ДО app:mounted и после перезагрузки, которую
 *   guard сделал сам; `kind` — `chunk` (чанк страницы) или `entry` (`<script type="module">` точки входа).
 *   Nuxt стартует первую навигацию раньше клиентского плагина Sentry, а entry может не скачаться вовсе,
 *   так что SDK к этому событию есть не всегда. Поэтому отправитель — только beacon; reporter SDK-пути
 *   (chunk-reload-report.ts) `retry-failed` игнорирует, и при поднятом SDK дубля нет.
 *
 * Остальные reason он игнорирует: при них приложение живо, и их шлёт плагин (chunk-reload-report.ts).
 * Одно событие на reason за загрузку страницы — как у reporter'а SDK-пути.
 *
 * Второе window-событие — `app:load-timeout` (guard ≥ 0.7.0): watchdog'а «приложение не загрузилось за N с».
 * Приложение не смонтировалось, значит клиентский SDK не поднят (в этом и смысл watchdog'а) — отправитель
 * снова только beacon, а SDK-путь это событие не слушает вовсе (иначе при поднятом SDK был бы дубль).
 *
 * Скрипт исполняется в самых старых браузерах, поэтому его текст — ES5 (`var`, `function`, без стрелок,
 * шаблонных строк, `?.`, `??`, spread) и обращается только к `window` и встроенным объектам. Он не
 * транспилируется: пишется строкой, чтобы текст в dist был ровно тем, что исполняется (ES5 и отсутствие
 * `</script>`/`<!--` проверяет тест). Шаблон — без комментариев и целиком ASCII: он уезжает в HTML каждой
 * страницы; кириллица попадает в текст только из вшитых шаблонов событий.
 *
 * Вшивается при сборке (JSON-литералом): DSN (обязателен в заголовке envelope — tunnelIngestUrl без
 * ключа), tunnelEndpoint, release, гейт localhost, версия, а также готовые шаблоны событий — по одному на
 * исход (`unsupported-browser`, `retry-failed` для каждого kind): тот же toChunkReloadBlockedEvent, что у
 * SDK-пути, поэтому заголовок/level/fingerprint/tags не расходятся. Скрипт добавляет только то, что известно
 * в браузере: event_id, timestamp, request (URL, User-Agent), environment, release, sdk — и поля из
 * detail: исходную ошибку (тег chunk.error и contexts.chunk.error — те же правила, что у summarizeError:
 * name/message/stack, обрезка, в теге одна строка) и адрес скрипта contexts.chunk.url. Тест сверяет
 * результат с toChunkReloadBlockedEvent на одном и том же detail.
 *
 * Событие watchdog'а (`app:load-timeout`) устроено иначе: его значения целиком приходят из detail в рантайме
 * (числа, стадия, хост, состояние документа, списки pending и errors…), поэтому в скрипт вшиваются только
 * части заголовка (кириллица в тексте скрипта запрещена: общий заголовок и уточнения по стадии), уровень,
 * корень fingerprint и подстановка хоста для network без host, а заголовок, fingerprint, теги и contexts.load
 * скрипт собирает сам — теми же правилами, что toLoadTimeoutEvent (load-timeout-report.ts). Каждое поле detail
 * проверяется по типу отдельно, битое просто не попадает в событие. Тест сверяет оба пути на одних и тех же detail.
 *
 * Отправка — navigator.sendBeacon, фолбэк — fetch с keepalive, когда sendBeacon нет, вернул false (очередь
 * отклонена) или бросил. У unsupported-browser запрос начинается уже после window.stop() (порядок guard), поэтому
 * остановка его не касается; keepalive переживает и выгрузку страницы.
 * Выключен там же, где клиентский SDK: localhost при excludeLocalhostInProd (shouldEnableClientSentry);
 * сам модуль добавляет скрипт только в production-сборке.
 */

export const EARLY_BEACON_HEAD_KEY = 'nuxt-sentry-early-beacon'
export const EARLY_BEACON_SDK_NAME = 'nuxt-sentry.early-beacon'

export interface EarlyBeaconOptions {
  dsn: string
  tunnelEndpoint: string
  release: string | undefined
  excludeLocalhostInProd: boolean
  /* Версия пакета — уходит в sdk.version события. */
  version: string
}

/*
 * JSON → JS-литерал для inline <script>. `<` экранируется, чтобы в тексте не могло оказаться `</script>`
 * и `<!--` (значения — DSN/release из конфига/env), U+2028/U+2029 — перевод строки внутри строкового
 * литерала в ES5 это синтаксическая ошибка.
 */
function toScriptLiteral(value: unknown): string {
  return JSON.stringify(value).replaceAll(
    /[<\u2028\u2029]/gu,
    (char) => `\\u${(char.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`,
  )
}

/* Тело: ES5. Внутри нельзя ни обратные кавычки, ни `${`. */
function scriptSource(configLiteral: string): string {
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
    if (!ch) {
      return;
    }
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
  function num(v) {
    return typeof v === 'number' && isFinite(v);
  }
  function str(v) {
    return typeof v === 'string' ? v : '';
  }
  function label(s) {
    return clip(s.replace(/\s+/g, ' '), 200).trim();
  }
  function put(e, k, v, tagged) {
    if (num(v)) {
      e.contexts.load[k] = v;
      if (tagged) {
        e.tags['load.' + k] = '' + v;
      }
    }
  }
  function flag(e, k, v) {
    if (typeof v === 'boolean') {
      e.contexts.load[k] = v;
      e.tags['load.' + k] = '' + v;
    }
  }
  function texts(v) {
    var r = [];
    var i;
    if (!Array.isArray(v)) {
      return null;
    }
    for (i = 0; i < v.length; i++) {
      if (typeof v[i] === 'string') {
        r.push(clip(v[i], 2000));
      }
    }
    return r;
  }
  function errs(v) {
    var r = [];
    var i;
    var x;
    var o;
    if (!Array.isArray(v)) {
      return null;
    }
    for (i = 0; i < v.length; i++) {
      x = v[i];
      if (x && typeof x === 'object' && typeof x.message === 'string') {
        o = { message: clip(x.message, 2000) };
        if (typeof x.source === 'string' && x.source !== '') {
          o.source = clip(x.source, 2000);
        }
        r.push(o);
      }
    }
    return r;
  }
  function loadTimeoutEvent(d) {
    var t = c.loadTimeout;
    var e = {
      message: t.generic,
      level: t.level,
      fingerprint: [t.fingerprint],
      tags: {},
      contexts: { load: {} }
    };
    var l = e.contexts.load;
    var g = e.tags;
    var st = d.stage === 'network' || d.stage === 'boot' ? d.stage : '';
    var host = st === 'network' ? str(d.host) : '';
    var hl = label(host);
    var rs = str(d.readyState);
    var rl = label(rs);
    var u = str(d.url);
    var p = texts(d.pending);
    var er = errs(d.errors);
    if (num(d.timeoutMs) && d.timeoutMs > 0) {
      e.message = t.prefix + Math.round(d.timeoutMs / 1000) + t.suffix;
    }
    put(e, 'timeoutMs', d.timeoutMs, true);
    put(e, 'visibleMs', d.visibleMs, true);
    put(e, 'hiddenMs', d.hiddenMs, true);
    put(e, 'elapsedMs', d.elapsedMs, true);
    if (u !== '') {
      l.url = clip(u, 2000);
    }
    if (d.kind === 'chunk' || d.kind === 'entry') {
      g['load.kind'] = d.kind;
      l.kind = d.kind;
    }
    if (st !== '') {
      g['load.stage'] = st;
      l.stage = st;
      e.fingerprint.push(st);
    }
    if (st === 'network') {
      e.message += t.networkPrefix + (hl === '' ? t.unknownHost : hl) + t.networkSuffix;
      e.fingerprint.push(hl === '' ? t.unknownHost : hl);
    } else if (st === 'boot') {
      e.message += t.boot;
    }
    if (hl !== '') {
      g['load.host'] = hl;
      l.host = clip(host, 2000);
    }
    if (rl !== '') {
      g['load.readyState'] = rl;
      l.readyState = clip(rs, 2000);
    }
    flag(e, 'online', d.online);
    flag(e, 'vueMounted', d.vueMounted);
    put(e, 'pendingCount', d.pendingCount, true);
    put(e, 'criticalCount', d.criticalCount, false);
    if (p) {
      l.pending = p;
    }
    if (er) {
      l.errors = er;
    }
    return e;
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
  w.addEventListener('app:load-timeout', function (e) {
    var d = e && e.detail;
    if (!d || typeof d !== 'object' || sent['load-timeout']) {
      return;
    }
    sent['load-timeout'] = true;
    try {
      send(loadTimeoutEvent(d), d);
    } catch (err) {}
  });
})(window);`
}

export function buildEarlyBeaconScript(options: EarlyBeaconOptions): string {
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
          reason: 'unsupported-browser',
          event: toChunkReloadBlockedEvent({ reason: 'unsupported-browser', missing: 'importmap' }),
        },
        ...RETRY_FAILED_KINDS.map((kind) => ({
          reason: 'retry-failed',
          kind,
          event: toChunkReloadBlockedEvent({ reason: 'retry-failed', kind }),
        })),
      ],
      /* Watchdog'а «приложение не загрузилось за N с»: значения приходят из detail в рантайме, вшиты только
         части заголовка (кириллица в тексте скрипта запрещена), уровень, корень fingerprint и подстановка хоста. */
      loadTimeout: {
        prefix: LOAD_TIMEOUT_MESSAGE_PREFIX,
        suffix: LOAD_TIMEOUT_MESSAGE_SUFFIX,
        generic: LOAD_TIMEOUT_MESSAGE_GENERIC,
        networkPrefix: LOAD_TIMEOUT_MESSAGE_NETWORK_PREFIX,
        networkSuffix: LOAD_TIMEOUT_MESSAGE_NETWORK_SUFFIX,
        boot: LOAD_TIMEOUT_MESSAGE_BOOT,
        unknownHost: LOAD_TIMEOUT_HOST_UNKNOWN,
        level: LOAD_TIMEOUT_LEVEL,
        fingerprint: LOAD_TIMEOUT_FINGERPRINT,
      },
    }),
  )
}
