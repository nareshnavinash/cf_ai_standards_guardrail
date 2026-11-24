import { DurableObject } from 'cloudflare:workers'
import { ControlStore, type ClaimArgs, type ClaimResult, type ReserveChatArgs } from './control-store'
import type { Env } from './types'

/** One global instance (`idFromName('global')`). Free-plan KV allows only 1,000 writes/day, so all hot state lives here. */
export class Control extends DurableObject<Env> {
  private store: ControlStore
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new ControlStore(ctx.storage.sql)
  }
  async claimReview(a: ClaimArgs): Promise<ClaimResult> {
    return this.store.claimReview(a)
  }
  async releaseReview(reviewId: string, refund: boolean): Promise<void> {
    this.store.releaseReview(reviewId, refund)
  }
  async clearInflight(reviewId: string): Promise<void> {
    this.store.clearInflight(reviewId)
  }
  async getReviewIndex(id: string): Promise<{ repo: string; memoryKey: string; visitor: string; createdAt: number } | null> {
    return this.store.getReviewIndex(id)
  }
  async getDiff(id: string): Promise<string | null> {
    return this.store.getDiff(id)
  }
  async recordUsage(key: string, day: string, neurons: number): Promise<void> {
    this.store.recordUsage(key, day, neurons)
  }
  async reserveNeurons(day: string, key: string, amount: number, budget: number): Promise<boolean> {
    return this.store.reserveNeurons(day, key, amount, budget)
  }
  async settleNeurons(key: string, actual: number): Promise<void> {
    this.store.settleNeurons(key, actual)
  }
  async reserveChat(a: ReserveChatArgs): Promise<'ok' | 'daily' | 'review' | 'ip' | 'budget'> {
    return this.store.reserveChat(a)
  }
  async refundChat(a: { reviewId: string; day: string; ip: string | null }): Promise<void> {
    this.store.refundChat(a)
  }
}
