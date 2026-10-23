import type { LoadTimeoutDetail } from '../../../src/runtime/utils/load-timeout-report'

/*
 * Detail watchdog'а guard ≥ 0.8.0 и событие, которое по нему обязаны построить ОБА пути — SDK-маппинг
 * (toLoadTimeoutEvent) и ES5-скрипт раннего beacon'а. Ожидаемые события записаны литералами, а не
 * вычисляются: паритет двух реализаций проверяет отдельный тест, а эти литералы фиксируют, что они оба верны.
 */

export interface ExpectedReport {
  message: string
  level: string
  fingerprint: string[]
  tags: Record<string, string>
  contexts: { load: Record<string, unknown> }
}

export const PAGE_URL = 'https://kp.modmb.com/clients/ckx1a2b3c'
export const ENTRY_CSS = 'cdn.pushka.biz/_nuxt/entry.DkQ1x.css'
export const ENTRY_JS = 'cdn.pushka.biz/_nuxt/entry.DkQ1x.js'

/*
 * Сигнатура KP-MODMB-COM-1J: head-CSS шрифтов завис, документ ещё стримится (loading), #__nuxt не появился,
 * ошибок нет. Часть времени вкладка была скрыта (hiddenMs), в порог оно не вошло (visibleMs ≥ timeoutMs).
 */
export const NETWORK_DETAIL: LoadTimeoutDetail = {
  reason: 'load-timeout',
  timeoutMs: 30_000,
  visibleMs: 30_002,
  hiddenMs: 4_100,
  elapsedMs: 34_102,
  url: PAGE_URL,
  stage: 'network',
  host: 'fonts.googleapis.com',
  readyState: 'loading',
  online: true,
  pending: ['fonts.googleapis.com/css2', ENTRY_CSS],
  pendingCount: 2,
  criticalCount: 9,
  vueMounted: false,
  errors: [],
}

export const NETWORK_EVENT: ExpectedReport = {
  message: 'Приложение не загрузилось за 30 с: не пришли ресурсы (fonts.googleapis.com)',
  level: 'error',
  fingerprint: ['app-load-timeout', 'network', 'fonts.googleapis.com'],
  tags: {
    'load.timeoutMs': '30000',
    'load.visibleMs': '30002',
    'load.hiddenMs': '4100',
    'load.elapsedMs': '34102',
    'load.stage': 'network',
    'load.host': 'fonts.googleapis.com',
    'load.readyState': 'loading',
    'load.online': 'true',
    'load.vueMounted': 'false',
    'load.pendingCount': '2',
  },
  contexts: {
    load: {
      timeoutMs: 30_000,
      visibleMs: 30_002,
      hiddenMs: 4_100,
      elapsedMs: 34_102,
      url: PAGE_URL,
      stage: 'network',
      host: 'fonts.googleapis.com',
      readyState: 'loading',
      online: true,
      vueMounted: false,
      pendingCount: 2,
      criticalCount: 9,
      pending: ['fonts.googleapis.com/css2', ENTRY_CSS],
      errors: [],
    },
  },
}

/* Всё пришло (pending пуст), документ разобран, приложение не стартовало: до монтирования упала ошибка. */
export const BOOT_DETAIL: LoadTimeoutDetail = {
  reason: 'load-timeout',
  timeoutMs: 30_000,
  visibleMs: 30_004,
  hiddenMs: 0,
  elapsedMs: 30_004,
  url: PAGE_URL,
  stage: 'boot',
  readyState: 'interactive',
  online: true,
  pending: [],
  pendingCount: 0,
  criticalCount: 9,
  vueMounted: false,
  errors: [{ message: "Cannot read properties of undefined (reading 'use')", source: `${ENTRY_JS}:1:48213` }],
}

export const BOOT_EVENT: ExpectedReport = {
  message: 'Приложение не загрузилось за 30 с: сбой при старте',
  level: 'error',
  fingerprint: ['app-load-timeout', 'boot'],
  tags: {
    'load.timeoutMs': '30000',
    'load.visibleMs': '30004',
    'load.hiddenMs': '0',
    'load.elapsedMs': '30004',
    'load.stage': 'boot',
    'load.readyState': 'interactive',
    'load.online': 'true',
    'load.vueMounted': 'false',
    'load.pendingCount': '0',
  },
  contexts: {
    load: {
      timeoutMs: 30_000,
      visibleMs: 30_004,
      hiddenMs: 0,
      elapsedMs: 30_004,
      url: PAGE_URL,
      stage: 'boot',
      readyState: 'interactive',
      online: true,
      vueMounted: false,
      pendingCount: 0,
      criticalCount: 9,
      pending: [],
      errors: [{ message: "Cannot read properties of undefined (reading 'use')", source: `${ENTRY_JS}:1:48213` }],
    },
  },
}

/* Detail guard 0.7.0: без стадии и диагностики; url — адрес страницы. */
export const LEGACY_DETAIL: LoadTimeoutDetail = {
  reason: 'load-timeout',
  timeoutMs: 45_000,
  elapsedMs: 45_123,
  url: PAGE_URL,
  kind: 'entry',
}

export const LEGACY_EVENT: ExpectedReport = {
  message: 'Приложение не загрузилось за 45 с',
  level: 'error',
  fingerprint: ['app-load-timeout'],
  tags: { 'load.timeoutMs': '45000', 'load.elapsedMs': '45123', 'load.kind': 'entry' },
  contexts: { load: { timeoutMs: 45_000, elapsedMs: 45_123, url: PAGE_URL, kind: 'entry' } },
}

/* Detail с подменёнными полями — в том числе битыми: тип намеренно не проверяется (detail приходит из другой ревизии guard). */
export function detailWith(base: LoadTimeoutDetail, overrides: Record<string, unknown>): LoadTimeoutDetail {
  return { ...base, ...overrides }
}

/* Событие без поля `key` — тега load.<key> и ключа контекста: так выглядит отчёт, у которого это поле было битым. */
export function reportWithout(report: ExpectedReport, key: string): ExpectedReport {
  const { [`load.${key}`]: _tag, ...tags } = report.tags
  const { [key]: _field, ...load } = report.contexts.load
  return { ...report, tags, contexts: { load } }
}
