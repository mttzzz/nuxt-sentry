import { describe, expect, it } from 'vitest'

import { enrichEnvelope } from '../../src/runtime/utils/enrich-envelope'

/*
 * Sentry envelope spec: первая строка — JSON envelope header, дальше пары
 *   <item header JSON>\n<payload>\n
 * Если у item-header есть `length` (int), payload — ровно столько байт; иначе
 * payload до следующего \n. Используем Buffer для byte-уровня — binary
 * attachment payload'ы могут содержать non-UTF-8 байты и должны оставаться
 * нетронутыми byte-for-byte.
 *
 * Эти тесты — TDD для util enrichEnvelope, который вызывается в tunnel.post.ts
 * перед форвардом в ingest.sentry.io. Цель: инжектить реальный client IP +
 * (опц.) auth user payload в event/transaction items, чтобы Sentry не видел
 * IP пода k8s вместо настоящего адреса юзера. Подход скопирован с masterm
 * (commits 55beeef + cde00aa) с поправкой на Buffer-based byte-парсинг.
 */

function buildEnvelope(items: { header: Record<string, unknown>; payload: string | Buffer }[]): Buffer {
  const head = `${JSON.stringify({ event_id: 'abc123', sent_at: '2026-01-01T00:00:00Z' })}\n`
  const parts: Buffer[] = [Buffer.from(head, 'utf8')]
  for (const { header, payload } of items) {
    parts.push(Buffer.from(`${JSON.stringify(header)}\n`, 'utf8'))
    parts.push(typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload)
    parts.push(Buffer.from('\n', 'utf8'))
  }
  return Buffer.concat(parts)
}

/* Распаковка envelope для проверки assertion'ов — повторяет логику парсера. */
interface ParsedItem {
  header: Record<string, unknown>
  payload: Buffer
}
function parseEnvelope(envelope: Buffer): { head: Record<string, unknown>; items: ParsedItem[] } {
  const newlineIdx = envelope.indexOf(0x0a)
  const head = JSON.parse(envelope.subarray(0, newlineIdx).toString('utf8')) as Record<string, unknown>
  const items: ParsedItem[] = []
  let pos = newlineIdx + 1
  while (pos < envelope.length) {
    const headerEnd = envelope.indexOf(0x0a, pos)
    if (headerEnd === -1) {
      break
    }
    const header = JSON.parse(envelope.subarray(pos, headerEnd).toString('utf8')) as Record<string, unknown>
    pos = headerEnd + 1
    let payload: Buffer
    if (typeof header.length === 'number') {
      payload = envelope.subarray(pos, pos + header.length)
      pos += header.length
      if (envelope[pos] === 0x0a) {
        pos++
      }
    } else {
      const payloadEnd = envelope.indexOf(0x0a, pos)
      if (payloadEnd === -1) {
        payload = envelope.subarray(pos)
        pos = envelope.length
      } else {
        payload = envelope.subarray(pos, payloadEnd)
        pos = payloadEnd + 1
      }
    }
    items.push({ header, payload })
  }
  return { head, items }
}

describe('enrichEnvelope', () => {
  it('инжектит ip_address в user объект event-item', () => {
    const envelope = buildEnvelope([{ header: { type: 'event' }, payload: JSON.stringify({ message: 'boom' }) }])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.42', user: {} })

    const parsed = parseEnvelope(out)
    const event = JSON.parse(parsed.items[0]!.payload.toString('utf8')) as { user: { ip_address: string } }
    expect(event.user.ip_address).toBe('203.0.113.42')
  })

  it('инжектит auth user (id/email/username) и сохраняет существующие user-поля', () => {
    const existing = { ip_address: 'stale', segment: 'beta', custom: 'keep-me' }
    const envelope = buildEnvelope([
      { header: { type: 'event' }, payload: JSON.stringify({ message: 'x', user: existing }) },
    ])

    const out = enrichEnvelope(envelope, {
      ip: '198.51.100.7',
      user: { id: 'u-1', email: 'a@b.test', username: 'Alice' },
    })

    const parsed = parseEnvelope(out)
    const event = JSON.parse(parsed.items[0]!.payload.toString('utf8')) as {
      user: Record<string, string>
    }
    /* Ip_address и id/email/username — из injection (overwrite). */
    expect(event.user.ip_address).toBe('198.51.100.7')
    expect(event.user.id).toBe('u-1')
    expect(event.user.email).toBe('a@b.test')
    expect(event.user.username).toBe('Alice')
    /* Кастомные поля — сохраняются. */
    expect(event.user.segment).toBe('beta')
    expect(event.user.custom).toBe('keep-me')
  })

  it('инжектит ip_address в transaction-item', () => {
    const envelope = buildEnvelope([{ header: { type: 'transaction' }, payload: JSON.stringify({ spans: [] }) }])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.99', user: {} })

    const parsed = parseEnvelope(out)
    const tx = JSON.parse(parsed.items[0]!.payload.toString('utf8')) as { user: { ip_address: string } }
    expect(tx.user.ip_address).toBe('203.0.113.99')
  })

  it('пропускает session/attachment items без модификаций', () => {
    const sessionPayload = JSON.stringify({ sid: 's-1' })
    const envelope = buildEnvelope([
      { header: { type: 'session' }, payload: sessionPayload },
      { header: { type: 'attachment', length: 5 }, payload: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]) },
    ])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.1', user: { id: 'u-9' } })

    const parsed = parseEnvelope(out)
    expect(parsed.items[0]!.payload.toString('utf8')).toBe(sessionPayload)
    expect([...parsed.items[1]!.payload]).toEqual([0x00, 0x01, 0x02, 0x03, 0xff])
  })

  it('корректно обновляет length для length-prefixed event-item после инжекта', () => {
    const original = JSON.stringify({ message: 'hi' })
    const envelope = buildEnvelope([
      { header: { type: 'event', length: Buffer.byteLength(original, 'utf8') }, payload: original },
    ])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.7', user: { id: 'u-1' } })

    const parsed = parseEnvelope(out)
    const item = parsed.items[0]!
    expect(item.header.length).toBe(item.payload.length)
    /* Новый length > старый (мы добавили user объект с двумя полями). */
    expect((item.header.length as number) > Buffer.byteLength(original, 'utf8')).toBe(true)
    const event = JSON.parse(item.payload.toString('utf8')) as { user: Record<string, string> }
    expect(event.user.ip_address).toBe('203.0.113.7')
    expect(event.user.id).toBe('u-1')
  })

  it('возвращает envelope as-is когда injection пустой (нет ip и user)', () => {
    const envelope = buildEnvelope([{ header: { type: 'event' }, payload: JSON.stringify({ message: 'x' }) }])

    const out = enrichEnvelope(envelope, { ip: '', user: {} })

    expect(out.equals(envelope)).toBe(true)
  })

  it('multi-item envelope: event обогащён, attachment остался byte-for-byte', () => {
    const eventPayload = JSON.stringify({ message: 'first' })
    const binary = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x0a, 0x42])
    const envelope = buildEnvelope([
      { header: { type: 'event' }, payload: eventPayload },
      { header: { type: 'attachment', length: binary.length, filename: 'screenshot.bin' }, payload: binary },
    ])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.50', user: { id: 'u-2' } })

    const parsed = parseEnvelope(out)
    const event = JSON.parse(parsed.items[0]!.payload.toString('utf8')) as { user: Record<string, string> }
    expect(event.user.ip_address).toBe('203.0.113.50')
    expect(event.user.id).toBe('u-2')
    expect([...parsed.items[1]!.payload]).toEqual([...binary])
    expect(parsed.items[1]!.header.filename).toBe('screenshot.bin')
  })

  it('кривой JSON в event-payload — passthrough без crash', () => {
    const broken = '{not-json'
    const envelope = buildEnvelope([{ header: { type: 'event' }, payload: broken }])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.1', user: { id: 'u-1' } })

    const parsed = parseEnvelope(out)
    expect(parsed.items[0]!.payload.toString('utf8')).toBe(broken)
  })

  it('инжектит только ip когда user пустой', () => {
    const envelope = buildEnvelope([{ header: { type: 'event' }, payload: JSON.stringify({ message: 'hi' }) }])

    const out = enrichEnvelope(envelope, { ip: '203.0.113.42', user: {} })

    const parsed = parseEnvelope(out)
    const event = JSON.parse(parsed.items[0]!.payload.toString('utf8')) as { user: { ip_address: string; id?: string } }
    expect(event.user.ip_address).toBe('203.0.113.42')
    expect(event.user.id).toBeUndefined()
  })

  it('инжектит только user когда ip пустой', () => {
    const envelope = buildEnvelope([{ header: { type: 'event' }, payload: JSON.stringify({ message: 'hi' }) }])

    const out = enrichEnvelope(envelope, { ip: '', user: { id: 'u-7', email: 'x@y.z' } })

    const parsed = parseEnvelope(out)
    const event = JSON.parse(parsed.items[0]!.payload.toString('utf8')) as {
      user: { id?: string; email?: string; ip_address?: string }
    }
    expect(event.user.id).toBe('u-7')
    expect(event.user.email).toBe('x@y.z')
    expect(event.user.ip_address).toBeUndefined()
  })
})
