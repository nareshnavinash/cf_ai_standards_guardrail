import { DurableObject } from 'cloudflare:workers'
import { ControlStore } from './control-store'
import type { Env, ReviewMode } from './types'

/** One global instance (`idFromName('global')`). Free-plan KV allows only 1,000 writes/day, so all hot state lives here. */
export class Control extends DurableObject<Env> {
  private store: ControlStore
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new ControlStore(ctx.storage.sql)
  }
  async registerReview(id: string, repo: string, memoryKey: string, visitor: string, diff: string): Promise<void> {
    this.store.registerReview(id, repo, memoryKey, visitor, diff)
  }
  async getReviewIndex(id: string): Promise<{ repo: string; memoryKey: string; visitor: string } | null> {
    return this.store.getReviewIndex(id)
  }
  async getDiff(id: string): Promise<string | null> {
    return this.store.getDiff(id)
  }
  async getInflight(key: string): Promise<{ reviewId: string; mode: ReviewMode } | null> {
    return this.store.getInflight(key)
  }
  async setInflight(key: string, reviewId: string, mode: ReviewMode): Promise<void> {
    this.store.setInflight(key, reviewId, mode)
  }
  async clearInflight(reviewId: string): Promise<void> {
    this.store.clearInflight(reviewId)
  }
  async reserveReview(day: string, cap: number): Promise<boolean> {
    return this.store.reserveReview(day, cap)
  }
  async reserveChat(reviewId: string, day: string, dailyCap: number, perReviewCap: number): Promise<'ok' | 'daily' | 'review'> {
    return this.store.reserveChat(reviewId, day, dailyCap, perReviewCap)
  }
}
