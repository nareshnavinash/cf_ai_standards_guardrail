import { describe, expect, it } from 'vitest'
import { createLogger } from '../src/logger'

describe('createLogger', () => {
  it('writes one JSON line with level, event and fields', () => {
    const lines: string[] = []
    createLogger((l) => lines.push(l)).log('info', 'order.created', { orderId: 'a', totalCents: 1000 })
    expect(JSON.parse(lines[0])).toEqual({ level: 'info', event: 'order.created', orderId: 'a', totalCents: 1000 })
  })
})
