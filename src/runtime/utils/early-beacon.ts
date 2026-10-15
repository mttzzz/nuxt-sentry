import { toChunkReloadBlockedEvent } from './chunk-reload-report'
import { LOCAL_HOSTS } from './sentry-enabled'

/*
 * Ранний beacon для браузеров без import maps — inline-скрипт в <head>, которому не нужен SDK.
 *
 * Зачем. Nuxt 4.1+ кладёт entry в `<script type="importmap">` под ключом `#entry`; в WebKit без import
 * maps (iOS < 16.4) импорт падает, приложение не стартует, клиентский Sentry.init не выполняется —
 * ни одно событие (ai.pushka.biz, 15.10.2026: iPhone на iOS 16.0.2, `500 Module specifier '#entry' …`)
 * не может уйти штатным путём. stale-deploy-guard ловит такой браузер inline-скриптом в bodyClose
 * (до window.stop()) и диспатчит `app:chunk-reload-blocked` с reason `unsupported-browser`. Этот скрипт
 * стоит в head — раньше bodyClose-скрипта guard — слушает то же событие и сам, без SDK, отправляет
 * envelope в tunnel. Остальные reason он игнорирует: при них приложение живо, и их шлёт плагин
 * (chunk-reload-report.ts).
 *
 * Скрипт исполняется в самых старых браузерах, поэтому его текст — ES5 (`var`, `function`, без стрелок,
 * шаблонных строк, `?.`, `??`, spread) и обращается только к `window` и встроенным объектам. Он не
 * транспилируется: пишется строкой, чтобы текст в dist был ровно тем, что исполняется (ES5 и отсутствие
 * `</script>`/`<!--` проверяет тест). Шаблон — без комментариев и целиком ASCII: он уезжает в HTML каждой
 * страницы; кириллица попадает в текст только из вшитого шаблона события.
 *
 * Вшивается при сборке (JSON-литералом): DSN (обязателен в заголовке envelope — tunnelIngestUrl без
 * ключа), tunnelEndpoint, release, гейт localhost, версия, а также готовый шаблон события — тот же
 * toChunkReloadBlockedEvent, что у SDK-пути, поэтому заголовок/level/fingerprint/tags не расходятся.
 * Скрипт добавляет только то, что известно в браузере: event_id, timestamp, request (URL, User-Agent),
 * environment, release, sdk.
 *
 * Отправка — navigator.sendBeacon (по спецификации запрос не обрывается ни window.stop(), ни выгрузкой
 * страницы), фолбэк — fetch с keepalive, когда sendBeacon нет, вернул false (очередь отклонена) или бросил.
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
  var sent = false;
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
  function send() {
    var id = uuid();
    var ev = c.event;
    var ok = false;
    var body;
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
    if (sent || !d || d.reason !== 'unsupported-browser') {
      return;
    }
    sent = true;
    try {
      send();
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
      event: toChunkReloadBlockedEvent({ reason: 'unsupported-browser', missing: 'importmap' }),
    }),
  )
}
