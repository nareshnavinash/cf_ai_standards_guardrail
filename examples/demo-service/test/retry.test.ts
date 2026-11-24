import { describe, expect, it } from 'vitest'
import { retry } from '../src/retry'

describe('retry', () => {
  it('returns the first successful result', async () => {
    let calls = 0
    const result = await retry(async () => {
      calls++
      if (calls < 3) throw new Error('flaky')
      return 'ok'
    }, 3, 1)
    expect(result).toBe('ok')
    expect(calls).toBe(3)
  })
  it('gives up after the last attempt', async () => {
    await expect(retry(async () => { throw new Error('down') }, 2, 1)).rejects.toThrow('gave up after 2 attempts')
  })
})
