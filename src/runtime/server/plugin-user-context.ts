import * as Sentry from '@sentry/bun'
import { defineNitroPlugin } from 'nitropack/runtime'

interface MaybeUser {
  id?: string
  email?: string
  name?: string | null
}

/*
 * Обогащает Sentry isolation scope данными пользователя из Better Auth сессии.
 * Если в проекте есть auth-resolver-плагин, заполняющий `event.context.user`
 * (как у нас во всех трёх проектах через `nuxt-authorization` / better-auth),
 * этот плагин копирует id/email/username в Sentry user context.
 *
 * Если `event.context.user` не определён — просто не вызываем setUser, ничего
 * не ломаем; на afterResponse чистим scope.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const user = event.context.user as MaybeUser | undefined
    if (user?.id) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
        username: user.name ?? undefined,
      })
    }
  })

  nitroApp.hooks.hook('afterResponse', () => {
    Sentry.setUser(null)
  })
})
