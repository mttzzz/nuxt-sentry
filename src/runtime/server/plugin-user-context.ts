import * as Sentry from '@sentry/bun'
import { getRequestIP } from 'h3'
import { defineNitroPlugin } from 'nitropack/runtime'

interface MaybeUser {
  id?: string
  email?: string
  name?: string | null
}

/*
 * Обогащает Sentry isolation scope данными пользователя + реальным client IP
 * из X-Forwarded-For. Для server-side captured errors (nitro hooks 'error',
 * unhandled rejection в API-эндпоинтах) Sentry-Bun SDK берёт remote IP из
 * сокета — в k8s это internal pod-IP, не настоящий клиент. h3
 * `getRequestIP({xForwardedFor:true})` парсит первый IP из XFF, который
 * ставит LB/ingress.
 *
 * Если auth-resolver-плагин проекта заполнил `event.context.user` (better-auth
 * / nuxt-authorization), копируем id/email/username. Если нет — set'им только
 * ip_address как анонимного юзера (Sentry умеет — это валидный setUser-payload).
 *
 * На afterResponse чистим scope, чтобы между запросами не утекали данные.
 */
export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    const user = event.context.user as MaybeUser | undefined
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? undefined

    if (user?.id) {
      Sentry.setUser({
        id: user.id,
        email: user.email,
        username: user.name ?? undefined,
        ip_address: ip,
      })
    } else if (ip) {
      Sentry.setUser({ ip_address: ip })
    }
  })

  nitroApp.hooks.hook('afterResponse', () => {
    Sentry.setUser(null)
  })
})
