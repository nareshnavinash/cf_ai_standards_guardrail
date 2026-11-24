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
}
