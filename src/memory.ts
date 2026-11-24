import { DurableObject } from 'cloudflare:workers'
import { MemoryStore } from './memory-store'
import type { ChatTurn, Env, ExceptionRecord, ReviewResult } from './types'

/** Per-repo, per-visitor memory: exceptions, past reviews and chat history. The DO name is the memoryKey. */
export class RepoMemory extends DurableObject<Env> {
  private store: MemoryStore
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store = new MemoryStore(ctx.storage.sql)
  }
  async listExceptions(): Promise<ExceptionRecord[]> {
    return this.store.listExceptions()
  }
  async addException(input: { ruleId: string; pathGlob: string; reason: string }): Promise<ExceptionRecord> {
    return this.store.addException(input)
  }
  async removeException(id: string): Promise<boolean> {
    return this.store.removeException(id)
  }
  async saveReview(r: ReviewResult): Promise<void> {
    this.store.saveReview(r)
  }
  async getReview(id: string): Promise<ReviewResult | null> {
    return this.store.getReview(id)
  }
  async appendChat(reviewId: string, turns: ChatTurn[]): Promise<void> {
    this.store.appendChat(reviewId, turns)
  }
  async getChat(reviewId: string, limit: number): Promise<ChatTurn[]> {
    return this.store.getChat(reviewId, limit)
  }
}
