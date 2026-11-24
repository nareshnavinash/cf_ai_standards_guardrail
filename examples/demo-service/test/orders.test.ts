import { describe, expect, it } from 'vitest'
import { OrderStore } from '../src/orders'

const order = (id: string, createdAt: string, customerId = 'c1') => ({ id, customerId, totalCents: 1000, createdAt })

describe('OrderStore', () => {
  it('returns orders for a customer, newest first', () => {
    const s = new OrderStore()
    s.add(order('a', '2026-01-01'))
    s.add(order('b', '2026-02-01'))
    s.add(order('c', '2026-03-01', 'c2'))
    expect(s.forCustomer('c1').map((o) => o.id)).toEqual(['b', 'a'])
  })
  it('rejects negative totals', () => {
    expect(() => new OrderStore().add({ ...order('a', '2026-01-01'), totalCents: -1 })).toThrow(RangeError)
  })
})
