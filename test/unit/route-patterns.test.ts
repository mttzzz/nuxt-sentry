import { parse } from 'acorn'
import { describe, expect, it } from 'vitest'

import { createRouteMatcher, routePatternToRegExpSource } from '../../src/runtime/utils/route-patterns'

/* Один паттерн против одного пути — так, как его проверяет плагин. */
function matches(pattern: string, pathname: string): boolean {
  return createRouteMatcher([pattern])(pathname)
}

describe('паттерн с хвостом /** — префикс и всё под ним', () => {
  it.each([
    '/clients',
    '/clients/',
    '/clients/abc',
    '/clients/a/b',
    '/clients/a/b/c/',
    '/clients/a.b',
    '/clients/%D0%BA',
  ])('/clients/** совпадает с %s', (pathname) => {
    expect(matches('/clients/**', pathname)).toBe(true)
  })

  it.each(['/clientsx', '/client', '/', '/x/clients/abc', '/admin/clients', '/Clients/abc', '/clients-old/abc', ''])(
    '/clients/** не совпадает с %j (граница сегмента, регистр значим, префикс только в начале)',
    (pathname) => {
      expect(matches('/clients/**', pathname)).toBe(false)
    },
  )

  it('«всё ниже» не зависит от символа: перевод строки внутри пути не обрывает совпадение', () => {
    expect(matches('/clients/**', '/clients/a\nb')).toBe(true)
  })

  it.each(['/', '/a', '/a/b', '/a/b/c/'])('/** (корень) совпадает с %s', (pathname) => {
    expect(matches('/**', pathname)).toBe(true)
  })

  it('вложенный префикс: /a/b/** — сам /a/b и всё под ним, но не /a и не /a/bc', () => {
    expect(matches('/a/b/**', '/a/b')).toBe(true)
    expect(matches('/a/b/**', '/a/b/c/d')).toBe(true)
    expect(matches('/a/b/**', '/a')).toBe(false)
    expect(matches('/a/b/**', '/a/bc')).toBe(false)
  })
})

describe('точный путь', () => {
  it('/clients — только он сам: без слеша на конце, без вложенных и без соседей по префиксу', () => {
    expect(matches('/clients', '/clients')).toBe(true)
    expect(matches('/clients', '/clients/')).toBe(false)
    expect(matches('/clients', '/clients/abc')).toBe(false)
    expect(matches('/clients', '/clientsx')).toBe(false)
    expect(matches('/clients', '/CLIENTS')).toBe(false)
  })

  it('/ — только корень', () => {
    expect(matches('/', '/')).toBe(true)
    expect(matches('/', '/a')).toBe(false)
  })

  it('паттерн без ведущего слеша не совпадает ни с одним путём (location.pathname всегда начинается с /)', () => {
    expect(matches('clients/**', '/clients/abc')).toBe(false)
    expect(matches('clients', '/clients')).toBe(false)
  })
})

describe('* — ровно один непустой сегмент', () => {
  it('/clients/* совпадает с одним сегментом, но не с самим /clients, не с пустым сегментом и не с вложенными', () => {
    expect(matches('/clients/*', '/clients/abc')).toBe(true)
    expect(matches('/clients/*', '/clients/a.b')).toBe(true)
    expect(matches('/clients/*', '/clients/a\nb')).toBe(true)
    expect(matches('/clients/*', '/clients')).toBe(false)
    expect(matches('/clients/*', '/clients/')).toBe(false)
    expect(matches('/clients/*', '/clients/a/b')).toBe(false)
    expect(matches('/clients/*', '/clientsx/abc')).toBe(false)
  })

  it('* в середине: /users/*/edit', () => {
    expect(matches('/users/*/edit', '/users/42/edit')).toBe(true)
    expect(matches('/users/*/edit', '/users/edit')).toBe(false)
    expect(matches('/users/*/edit', '/users//edit')).toBe(false)
    expect(matches('/users/*/edit', '/users/42/43/edit')).toBe(false)
    expect(matches('/users/*/edit', '/users/42/edit/x')).toBe(false)
  })

  it('несколько *: /a/*/*', () => {
    expect(matches('/a/*/*', '/a/b/c')).toBe(true)
    expect(matches('/a/*/*', '/a/b')).toBe(false)
    expect(matches('/a/*/*', '/a/b/c/d')).toBe(false)
  })

  it('* вместе с хвостом /**: /*/** — первый сегмент любой, дальше что угодно', () => {
    expect(matches('/*/**', '/a')).toBe(true)
    expect(matches('/*/**', '/a/b/c')).toBe(true)
    expect(matches('/*/**', '/')).toBe(false)
  })
})

describe('спецсимволы регулярок в паттерне — обычные символы пути', () => {
  it.each([
    ['/a.b', '/axb'],
    ['/a+b', '/aab'],
    ['/a?b', '/b'],
    ['/a(b)', '/ab'],
    ['/a[bc]', '/ab'],
    ['/a{2}', '/aa'],
    ['/a|b', '/a'],
    ['/a^b', '/ab'],
    ['/a$', '/a'],
    [String.raw`/\d`, '/5'],
  ])('%s: совпадает сам с собой и не совпадает как регулярка (%s)', (pattern, lookalike) => {
    expect(matches(pattern, pattern)).toBe(true)
    expect(matches(pattern, lookalike)).toBe(false)
  })

  it('и вместе с хвостом: /v1.0/** — точка литерал', () => {
    expect(matches('/v1.0/**', '/v1.0/x')).toBe(true)
    expect(matches('/v1.0/**', '/v1x0/x')).toBe(false)
  })
})

describe('источник RegExp — общий для плагина и ES5-скрипта beacon', () => {
  it.each([
    ['/clients', '^/clients$'],
    ['/clients/**', String.raw`^/clients(?:/[\s\S]*)?$`],
    ['/clients/*', '^/clients/[^/]+$'],
    ['/users/*/edit', '^/users/[^/]+/edit$'],
    ['/**', String.raw`^(?:/[\s\S]*)?$`],
    ['/a.b', String.raw`^/a\.b$`],
  ])('%s → %s', (pattern, source) => {
    expect(routePatternToRegExpSource(pattern)).toBe(source)
  })

  it.each(['/clients', '/clients/**', '/clients/*', '/users/*/edit', '/**', '/a.b+c(d)[e]{2}|f^g$h', String.raw`/\d`])(
    'источник %s компилируется без флагов и разбирается как RegExp-литерал ES5',
    (pattern) => {
      const source = routePatternToRegExpSource(pattern)

      // oxlint-disable-next-line require-unicode-regexp -- как в ES5-скрипте beacon'а: без флагов
      expect(() => new RegExp(source)).not.toThrow()
      expect(() =>
        parse(`/${source.replaceAll('/', String.raw`\/`)}/`, { ecmaVersion: 5, sourceType: 'script' }),
      ).not.toThrow()
    },
  )
})

describe('неподдерживаемый синтаксис * / ** — ошибка, а не молчаливое «не совпало»', () => {
  it.each(['/a*', '/*a/b', '/a/b*c', '/a**', '/a/**/b', '/**/', '/a/***', '**'])('%s', (pattern) => {
    expect(() => routePatternToRegExpSource(pattern)).toThrow(/unsupported pattern/u)
    expect(() => routePatternToRegExpSource(pattern)).toThrow(JSON.stringify(pattern))
    expect(() => routePatternToRegExpSource(pattern)).toThrow('sentry.client.disabledRoutes')
  })

  it('createRouteMatcher бросает при создании, а не при первой сверке', () => {
    expect(() => createRouteMatcher(['/ok/**', '/bad/**/x'])).toThrow(/unsupported pattern/u)
  })
})

describe('createRouteMatcher: список', () => {
  it('пустой список не совпадает ни с чем', () => {
    const matcher = createRouteMatcher([])

    expect(matcher('/')).toBe(false)
    expect(matcher('/clients/abc')).toBe(false)
  })

  it('совпал хотя бы один паттерн', () => {
    const matcher = createRouteMatcher(['/clients/**', '/share/*'])

    expect(matcher('/clients/abc')).toBe(true)
    expect(matcher('/share/x')).toBe(true)
    expect(matcher('/share')).toBe(false)
    expect(matcher('/admin/partners')).toBe(false)
  })

  it('матчер без состояния: повторные вызовы на тех же путях дают те же ответы', () => {
    const matcher = createRouteMatcher(['/clients/**'])

    for (let round = 0; round < 3; round++) {
      expect(matcher('/clients/abc')).toBe(true)
      expect(matcher('/admin')).toBe(false)
    }
  })
})
