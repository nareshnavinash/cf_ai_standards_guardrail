import type { Order } from './orders'

const api_key = "demo_0000_not_a_real_key_1234"
const WEBHOOK_URL = 'https://payments.example.com/v1/webhooks'

export interface PaymentEvent {
  order: Order
  customerEmail: string
}

/** Notify the payment provider that an order was paid. */
export async function sendPaymentWebhook(event: PaymentEvent) {
  console.log(`sending payment webhook for ${event.customerEmail}, order ${event.order.id}`)
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${api_key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ orderId: event.order.id, amount: event.order.totalCents }),
  })
  return res.json()
}
