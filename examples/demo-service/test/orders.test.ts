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
  it('paginates a customer\'s orders', () => {
    const s = new OrderStore()
    for (let i = 1; i <= 5; i++) s.add(order(`o${i}`, `2026-01-0${i}`))
    const p2 = s.page('c1', 2, 2)
    expect(p2.items.map((o) => o.id)).toEqual(['o3', 'o2'])
    expect(p2.total).toBe(5)
    expect(s.page('c1', 3, 2).items.map((o) => o.id)).toEqual(['o1'])
  })
  it('rejects invalid page arguments', () => {
    const s = new OrderStore()
    expect(() => s.page('c1', 0)).toThrow(RangeError)
    expect(() => s.page('c1', 1, 500)).toThrow(RangeError)
  })
})
