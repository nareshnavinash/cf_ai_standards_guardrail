export class DurableObject<_E = unknown> {
  ctx: any
  env: any
  constructor(ctx: any, env: any) {
    this.ctx = ctx
    this.env = env
  }
}
export class WorkflowEntrypoint<_E = unknown, _P = unknown> {
  ctx: any
  env: any
  constructor(ctx: any, env: any) {
    this.ctx = ctx
    this.env = env
  }
}
export type WorkflowEvent<T> = { payload: T; timestamp: Date; instanceId: string }
export type WorkflowStep = any
