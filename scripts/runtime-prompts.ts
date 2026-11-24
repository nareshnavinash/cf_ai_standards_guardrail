/** Prints the prompts the app itself sends to the model, as Markdown. Used by export-prompts.mjs --runtime. */
import { buildSystemPrompt, LLM_MODEL } from '../src/checks/llm'
import { CHAT_SYSTEM_PROMPT } from '../src/chat'
import { RULES } from '../src/rules'

const fence = (s: string) => '```text\n' + s + '\n```'

console.log(
  [
    '## Runtime prompts',
    '',
    `These are the system prompts the deployed app sends to \`${LLM_MODEL}\`. They are written by the author and generated here from the source, so they cannot drift from the code.`,
    '',
    '### Standards check (one call per reviewed file)',
    '',
    fence(buildSystemPrompt(RULES)),
    '',
    'The user message is the file\'s added lines inside a `<code path="...">` tag, one `<line>: <text>` per row.',
    '',
    '### Chat',
    '',
    fence(CHAT_SYSTEM_PROMPT),
    '',
    'The chat context (findings, up to 6 KB of the flagged files\' added lines, the last 10 turns) is appended to this prompt as data.',
    '',
  ].join('\n'),
)
