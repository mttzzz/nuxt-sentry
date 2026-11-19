import { readdir } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildNuxt, loadNuxt } from '@nuxt/kit'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/*
 * Настоящая production-сборка фикстуры (SPA, клиентские карты hidden — как у ai.pushka.biz) с SENTRY_AUTH_TOKEN против
 * поддельного Sentry: плагин `@sentry/vite-plugin` с опцией `sourcemaps.deleteSourcemapsAfterUpload` обязан загрузить карты
 * и не оставить ни одной в `.output` — ни в публичном каталоге (образ, CDN), ни в серверном (его чистит хук `compiled`).
 */

const rootDir = fileURLToPath(new URL('../fixtures/sourcemaps', import.meta.url))
const outputDir = join(rootDir, '.output')

/* `.map` и его сжатые копии (compressPublicAssets кладёт `.map.gz`/`.map.br` рядом). */
const MAP_FILE = /\.map(?:\.(?:gz|br|zst))?$/u

interface SeenRequest {
  method: string
  url: string
  bytes: number
}

const requests: SeenRequest[] = []
let files: string[] = []
let stubServer: Server | undefined

/* Поддельный Sentry: ровно столько API, сколько нужно загрузке артефакт-бандла с debug-id. */
function startFakeSentry(): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
    })
    request.on('end', () => {
      requests.push({ method: request.method ?? '', url: request.url ?? '', bytes: Buffer.concat(chunks).length })
      response.setHeader('content-type', 'application/json')
      if (request.url?.includes('chunk-upload') && request.method === 'GET') {
        const { port } = server.address() as AddressInfo
        response.end(
          JSON.stringify({
            url: `http://127.0.0.1:${String(port)}/api/0/organizations/pushka-biz/chunk-upload/`,
            chunkSize: 8_388_608,
            chunksPerRequest: 64,
            maxFileSize: 2_147_483_648,
            maxRequestSize: 33_554_432,
            concurrency: 1,
            hashAlgorithm: 'sha1',
            compression: ['gzip'],
            accept: ['debug_files', 'release_files', 'sources', 'artifact_bundles', 'artifact_bundles_v2'],
          }),
        )
        return
      }
      if (request.url?.includes('assemble')) {
        response.end(JSON.stringify({ state: 'ok', missingChunks: [] }))
        return
      }
      response.end('{}')
    })
  })
  stubServer = server
  const listening = Promise.withResolvers<number>()
  server.listen(0, '127.0.0.1', () => {
    listening.resolve((server.address() as AddressInfo).port)
  })
  return listening.promise
}

beforeAll(async () => {
  const port = await startFakeSentry()
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SENTRY_AUTH_TOKEN', 'sntrys_test_token')
  vi.stubEnv('SENTRY_URL', `http://127.0.0.1:${String(port)}`)
  vi.stubEnv('SENTRY_RELEASE', '')
  const nuxt = await loadNuxt({ cwd: rootDir, dev: false })
  try {
    await buildNuxt(nuxt)
  } finally {
    await nuxt.close()
  }
  files = await readdir(outputDir, { recursive: true })
}, 300_000)

afterAll(() => {
  vi.unstubAllEnvs()
  stubServer?.close()
})

describe('production-сборка с SENTRY_AUTH_TOKEN: sourcemap', () => {
  it('сборка собралась: клиентские чанки и серверный бандл на месте', () => {
    expect(files.some((file) => file.startsWith('public/_nuxt/') && file.endsWith('.js'))).toBe(true)
    expect(files.some((file) => file.startsWith('server/'))).toBe(true)
  })

  it('в .output нет ни одного .map — ни публичного (образ, CDN), ни серверного', () => {
    expect(files.filter((file) => MAP_FILE.test(file))).toEqual([])
  })

  it('карты не потеряны: плагин отправил артефакт-бандл в Sentry', () => {
    const uploads = requests.filter(
      (seen) => seen.method === 'POST' && /chunk-upload|assemble/u.test(seen.url) && seen.bytes > 0,
    )
    expect(uploads.length, `запросы к Sentry: ${JSON.stringify(requests)}`).toBeGreaterThan(0)
  })
})
