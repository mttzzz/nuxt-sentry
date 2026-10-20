import { RETRY_FAILED_KINDS, toChunkReloadBlockedEvent } from './chunk-reload-report'
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
    }),
  )
}
