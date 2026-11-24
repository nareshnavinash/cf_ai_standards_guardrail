import { OrderStore } from './orders'

/** Export all orders of a customer as CSV for the account page. */
export function exportOrdersCsv(store: OrderStore, customerId: string): { status: number; body: string } {
  try {
    // TODO make this faster
    const rows = store.forCustomer(customerId).map((o) => [o.id, o.totalCents, o.createdAt].join(','))
    return { status: 200, body: ['id,total_cents,created_at', ...rows].join('\n') }
  } catch (err) {
    return { status: 500, body: (err as Error).stack ?? String(err) }
  }
}
