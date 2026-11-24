export interface Order {
  id: string
  customerId: string
  totalCents: number
  createdAt: string
}

export class OrderStore {
  private readonly orders = new Map<string, Order>()

  add(order: Order): void {
    if (order.totalCents < 0) throw new RangeError('totalCents must not be negative')
    this.orders.set(order.id, order)
  }

  get(id: string): Order | undefined {
    return this.orders.get(id)
  }

  /** All orders for one customer, newest first. */
  forCustomer(customerId: string): Order[] {
    return [...this.orders.values()]
      .filter((o) => o.customerId === customerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  /** One page of a customer's orders, newest first. `page` starts at 1. */
  page(customerId: string, page: number, pageSize = 20): { items: Order[]; total: number; page: number } {
    if (!Number.isInteger(page) || page < 1) throw new RangeError('page must be a positive integer')
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new RangeError('pageSize must be between 1 and 100')
    const all = this.forCustomer(customerId)
    return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page }
  }
}
