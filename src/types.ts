export type Severity = 'error' | 'warning'
export interface Rule { id: string; title: string; rationale: string; severity: Severity; kind: 'static' | 'llm'; guidance: string }
export interface AddedLine { line: number; text: string }
export interface DiffFile { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'binary'; added: AddedLine[]; truncated: boolean }
export interface Finding { ruleId: string; path: string; line: number | null; message: string; suggestion: string | null; source: 'static' | 'llm' }
export interface ExceptionRecord { id: string; ruleId: string; pathGlob: string; reason: string; createdAt: string }
export type ReviewMode = 'full' | 'static-only'
export interface ReviewResult { id: string; repo: string; prNumber: number | null; title: string; mode: ReviewMode; findings: Finding[]; suppressed: Finding[]; filesReviewed: number; skippedFiles: string[]; degradedFiles: string[]; truncated: boolean; rulesVersion: string; cached: boolean; createdAt: string }
export interface ChatTurn { role: 'user' | 'assistant'; content: string; at: string }
export interface ReviewParams { reviewId: string; repo: string; memoryKey: string; prNumber: number | null; title: string; diff: string; mode: ReviewMode }
export interface Env { AI: Ai; REVIEW_WORKFLOW: Workflow; REPO_MEMORY: DurableObjectNamespace; CONTROL: DurableObjectNamespace; CACHE: KVNamespace; REVIEW_LIMITER?: RateLimit; CHAT_LIMITER?: RateLimit; ASSETS: Fetcher; GITHUB_TOKEN?: string; EVAL_KEY?: string; DAILY_LLM_REVIEWS?: string; DAILY_CHAT_TURNS?: string }
