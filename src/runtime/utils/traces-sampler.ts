/*
 * Серверный tracesSampler: какие корневые спаны становятся транзакциями.
 *
 * Sentry зовёт tracesSampler только для КОРНЕВЫХ спанов (нет ни локального, ни удалённого
 * родителя), дочерние наследуют решение корня. Поэтому правила режут именно корни: db/cache-спаны
 * внутри настоящего запроса или джобы остаются в их транзакции.
 *
 * Правила, первое сработавшее побеждает:
 *   1. корень с sentry.op db / db.* / cache / cache.*  → 0;
 *   2. имя queue.publish/… или queue.process/…         → queueTracesSampleRate;
 *   3. путь из ignoredRoutes                            → 0;
 *   4. всё остальное                                    → tracesSampleRate.
 *
 * Фабрика чистая: rate'ы и ignoredRoutes приходят аргументами из instrument.server.ts.
 * Build-time плейсхолдеры подставляет renderChunk только в коде самого instrument-чанка,
 * поэтому в этом файле им не место.
 */

export interface TracesSamplerOptions {
  /** Доля транзакций для всего, что не попало под правила 1–3. */
  tracesSampleRate: number
  /** Доля для корней `queue.publish/…` и `queue.process/…`. */
  queueTracesSampleRate: number
  /** Префиксы пути запроса, которые не трассируем (`startsWith`, не граница сегмента). */
  ignoredRoutes: readonly string[]
}

/* Срез TracesSamplerSamplingContext Sentry — только то, что читает сэмплер. */
export interface TracesSamplingContext {
  name?: string
  attributes?: Readonly<Record<string, unknown>>
}

/*
 * Корневой db/cache-спан — всегда мусор, а не запрос, который стоит смотреть. Подписчик Sentry на
 * TracingChannel `ioredis:command` (@sentry/server-utils, redis/redis-dc-subscriber) биндит канал
 * БЕЗ requiresParentSpan (orchestrion-путь того же пакета его передаёт), а ioredis ≥ 5.11 — в том
 * числе вложенный в bull — публикует канал сам. Каждая Redis-команда вне любого спана (опрос bull:
 * BRPOPLPUSH/EVALSHA раз в 5 с на очередь, stream-консьюмеры XREADGROUP) становится корнем
 * `redis-<cmd>` с op `db.redis` и под tracesSampleRate превращается в транзакцию из одного спана.
 * ai.pushka.biz, прод, сутки (экстраполяция 10% выборки): ≈720k из ~800k транзакций — redis-evalsha
 * 335 800, redis-brpoplpush 313 580, redis-xreadgroup 34 300.
 */
const INFRASTRUCTURE_OP = /^(?:db|cache)(?:\.|$)/u

const QUEUE_SPAN_PREFIXES = ['queue.publish/', 'queue.process/'] as const

/* Имя http.server-спана — `${METHOD} ${route}` (Bun.serve: `GET /api/ws`). */
const HTTP_METHOD_PREFIX = /^[A-Z]+ /u

export function createTracesSampler(options: TracesSamplerOptions): (context: TracesSamplingContext) => number {
  const { tracesSampleRate, queueTracesSampleRate, ignoredRoutes } = options

  return ({ name, attributes }) => {
    const op = attributes?.['sentry.op']
    if (typeof op === 'string' && INFRASTRUCTURE_OP.test(op)) {
      return 0
    }

    /* Корни очередей стартует sentry-queue.ts по одному имени, без op — опознаём по имени. Идут раньше
       ignoredRoutes: у очередей свой rate. */
    if (name !== undefined && QUEUE_SPAN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return queueTracesSampleRate
    }

    /* У http.server-спана имя — `GET /api/ws`, а не `/api/ws`, поэтому прежний `name.startsWith('/api/ws')`
       не срабатывал никогда (ai.pushka.biz, сутки: `GET /api/ws` 4 390 и `POST /api/sentry-tunnel` 1 460
       транзакций при обоих маршрутах в дефолтных ignoredRoutes). Чистый путь лежит в атрибуте url.path;
       нет его — берём имя без ведущего HTTP-метода. Сравнение — startsWith: `/_nuxt` гасит всё поддерево. */
    const urlPath = attributes?.['url.path']
    const path = typeof urlPath === 'string' ? urlPath : name?.replace(HTTP_METHOD_PREFIX, '')
    if (path !== undefined && ignoredRoutes.some((route) => path.startsWith(route))) {
      /* Решение 0 нужно не только самому запросу: WS-хендлеры /api/ws исполняются под спаном апгрейда уже
         после его завершения, и Sentry отправляет каждый такой поздний дочерний спан отдельной транзакцией.
         Дочерний спан несэмплированного корня non-recording — слать нечего. */
      return 0
    }

    return tracesSampleRate
  }
}
