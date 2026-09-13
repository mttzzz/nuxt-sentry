/*
 * Sentry envelope spec: первая строка — JSON envelope header, дальше пары
 *   <item header JSON>\n<payload>\n
 * Если у item-header есть `length` (int), payload — ровно столько байт; иначе
 * payload до следующего \n.
 *
 * `enrichEnvelope` инжектит client-IP + (опц.) auth user payload в `user`
 * объект каждого event/transaction-item — иначе Sentry видит коннект из пода
 * k8s-кластера и пишет в user.ip_address egress-IP ноды вместо реального адреса
 * юзера. Session / attachment / прочие items пропускаются без изменений (важно
 * для binary attachment'ов: byte-for-byte passthrough).
 *
 * Работаем на Buffer'ах, а не строках — attachment может содержать не-UTF-8
 * байты (screenshot.bin, breadcrumbs.bin), `toString('utf8')` их сломает.
 *
 * Port masterm Laravel SentryTunnelController::enrichEnvelope (commits 55beeef +
 * cde00aa) с поправкой на JS Buffer-API.
 */

interface AuthUserPayload {
  id?: string | null
  email?: string | null
  username?: string | null
}

export interface EnvelopeEnrichment {
  ip: string
  user: AuthUserPayload
}

const LF = 0x0a

/* JSON.stringify эквивалент PHP JSON_UNESCAPED_SLASHES|JSON_UNESCAPED_UNICODE.
 * V8 по умолчанию НЕ экранирует слэши, и Unicode — только характеры < 0x20
 * (control chars), а буквы/символы оставляет литералами. То есть стандартного
 * stringify хватает — отдельных опций не нужно. */

function buildUserPatch(injection: EnvelopeEnrichment): Record<string, string> {
  const patch: Record<string, string> = {}
  if (injection.user.id) {
    patch.id = injection.user.id
  }
  if (injection.user.email) {
    patch.email = injection.user.email
  }
  if (injection.user.username) {
    patch.username = injection.user.username
  }
  if (injection.ip) {
    patch.ip_address = injection.ip
  }
  return patch
}

function indexOfByte(buf: Buffer, byte: number, from: number): number {
  return buf.indexOf(byte, from)
}

export function enrichEnvelope(envelope: Buffer, injection: EnvelopeEnrichment): Buffer {
  const userPatch = buildUserPatch(injection)
  if (Object.keys(userPatch).length === 0) {
    return envelope
  }

  const headerEol = indexOfByte(envelope, LF, 0)
  if (headerEol === -1) {
    return envelope
  }

  const out: Buffer[] = [envelope.subarray(0, headerEol + 1)]
  let pos = headerEol + 1
  const total = envelope.length

  while (pos < total) {
    const itemHeaderEol = indexOfByte(envelope, LF, pos)
    if (itemHeaderEol === -1) {
      /* Хвост без \n — спецификация envelope последний \n опционален. */
      out.push(envelope.subarray(pos))
      break
    }

    const itemHeaderBuf = envelope.subarray(pos, itemHeaderEol)
    pos = itemHeaderEol + 1

    let itemHeader: Record<string, unknown> | null
    try {
      itemHeader = JSON.parse(itemHeaderBuf.toString('utf8')) as Record<string, unknown>
    } catch {
      itemHeader = null
    }

    let payload: Buffer
    let hadTrailingLF = false
    if (itemHeader && typeof itemHeader.length === 'number') {
      const payloadLen = itemHeader.length
      payload = envelope.subarray(pos, pos + payloadLen)
      pos += payloadLen
      if (pos < total && envelope[pos] === LF) {
        hadTrailingLF = true
        pos++
      }
    } else {
      const payloadEol = indexOfByte(envelope, LF, pos)
      if (payloadEol === -1) {
        payload = envelope.subarray(pos)
        pos = total
      } else {
        payload = envelope.subarray(pos, payloadEol)
        pos = payloadEol + 1
        hadTrailingLF = true
      }
    }

    const type = itemHeader?.type
    const shouldEnrich = type === 'event' || type === 'transaction'
    if (shouldEnrich && itemHeader) {
      let mutatedPayload: Buffer | null = null
      try {
        const event = JSON.parse(payload.toString('utf8')) as { user?: Record<string, unknown> }
        if (event && typeof event === 'object') {
          const existing = event.user && typeof event.user === 'object' ? event.user : {}
          event.user = { ...existing, ...userPatch }
          mutatedPayload = Buffer.from(JSON.stringify(event), 'utf8')
        }
      } catch {
        /* Кривой JSON — passthrough без изменений. */
        mutatedPayload = null
      }

      if (mutatedPayload) {
        if (typeof itemHeader.length === 'number') {
          itemHeader.length = mutatedPayload.length
        }
        out.push(Buffer.from(`${JSON.stringify(itemHeader)}\n`, 'utf8'))
        out.push(mutatedPayload)
        if (hadTrailingLF) {
          out.push(Buffer.from('\n', 'utf8'))
        }
        continue
      }
    }

    /* Passthrough — оригинальный header (как было в bytes), оригинальный payload. */
    out.push(itemHeaderBuf)
    out.push(Buffer.from('\n', 'utf8'))
    out.push(payload)
    if (hadTrailingLF) {
      out.push(Buffer.from('\n', 'utf8'))
    }
  }

  return Buffer.concat(out)
}
