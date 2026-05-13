import { beforeEach, describe, expect, it, vi } from 'vitest'

const withMonitorMock = vi.fn(async (_slug: string, fn: () => Promise<unknown>, _config: unknown) => fn())

vi.mock('@sentry/bun', () => ({
  withMonitor: withMonitorMock,
}))

const { withCronMonitor } = await import('../../src/runtime/utils/sentry-cron')

describe('withCronMonitor', () => {
  beforeEach(() => {
    withMonitorMock.mockClear()
  })

  it('вызывает Sentry.withMonitor с slug, schedule (crontab) и дефолтами', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    const result = await withCronMonitor('amo-sync', '*/5 * * * *', fn)

    expect(result).toBe('ok')
    expect(withMonitorMock).toHaveBeenCalledOnce()
    const firstCall = withMonitorMock.mock.calls[0] as [string, unknown, unknown]
    expect(firstCall[0]).toBe('amo-sync')
    expect(firstCall[2]).toEqual({
      schedule: { type: 'crontab', value: '*/5 * * * *' },
      checkinMargin: 2,
      maxRuntime: 10,
      timezone: 'Etc/UTC',
    })
  })

  it('overrides: checkinMargin/maxRuntime', async () => {
    await withCronMonitor('long-task', '0 * * * *', async () => {}, { checkinMargin: 5, maxRuntime: 30 })
    const overrideCall = withMonitorMock.mock.calls[0] as [string, unknown, unknown]
    expect(overrideCall[2]).toMatchObject({ checkinMargin: 5, maxRuntime: 30 })
  })

  it('пробрасывает ошибку из fn (не глотает)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('task failed'))
    await expect(withCronMonitor('x', '* * * * *', fn)).rejects.toThrow('task failed')
  })
})
