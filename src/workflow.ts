import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers'
import type { Env, ReviewParams } from './types'

export class ReviewWorkflow extends WorkflowEntrypoint<Env, ReviewParams> {
  async run(_event: WorkflowEvent<ReviewParams>, _step: WorkflowStep): Promise<void> {}
}
