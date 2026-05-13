/* Smoke: использует все auto-imported helpers — проверяет, что nuxi prepare
   корректно генерирует типы и runtime подцепляет наши auto-imports. */
export default defineEventHandler(() => {
  const log = createLogger('smoke')
  log.info('smoke endpoint hit')
  return { ok: true }
})
