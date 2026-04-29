import { describe, expect, it } from 'vitest'

import { buildTunnelIngestUrl } from '../../src/runtime/utils/tunnel-ingest-url'

describe('buildTunnelIngestUrl', () => {
  it('из easy2 DSN строит правильный envelope-URL', () => {
    expect(
      buildTunnelIngestUrl('https://cb4e0da9f40eb6fa331bb26592b64bd1@o4510084335534080.ingest.de.sentry.io/4510651450196048'),
    ).toBe('https://o4510084335534080.ingest.de.sentry.io/api/4510651450196048/envelope/')
  })

  it('из ai DSN строит правильный envelope-URL', () => {
    expect(
      buildTunnelIngestUrl('https://ac85cd8ee4329180aeac9cf79d36ccd1@o4510084335534080.ingest.de.sentry.io/4511188847820880'),
    ).toBe('https://o4510084335534080.ingest.de.sentry.io/api/4511188847820880/envelope/')
  })

  it('из kp DSN строит правильный envelope-URL', () => {
    expect(
      buildTunnelIngestUrl('https://2f1dca6704c508f9b2a25aed782f6610@o4510084335534080.ingest.de.sentry.io/4511290279002192'),
    ).toBe('https://o4510084335534080.ingest.de.sentry.io/api/4511290279002192/envelope/')
  })

  it('падает на DSN без projectId', () => {
    expect(() => buildTunnelIngestUrl('https://key@host')).toThrow(/no project id/)
  })

  it('падает на не-URL', () => {
    expect(() => buildTunnelIngestUrl('not-a-url')).toThrow(/Invalid DSN format/)
  })

  it('терпимо относится к trailing slash', () => {
    expect(
      buildTunnelIngestUrl('https://k@h.example/123/'),
    ).toBe('https://h.example/api/123/envelope/')
  })
})
