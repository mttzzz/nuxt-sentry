/*
 * Тестовый endpoint — бросает unhandled-ошибку, чтобы убедиться что nitro `error`
 * хук модуля её ловит и форвардит в Sentry. В тестовых фикстурах NUXT_TEST_MODE=1 —
 * tunnel вернёт 204, реальный envelope в Sentry не уходит.
 */
export default defineEventHandler(() => {
  throw new Error('playground __throw — should be captured by nuxt-sentry')
})
