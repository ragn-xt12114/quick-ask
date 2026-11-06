/**
 * Multi-turn context assembly (plan D.8 / F-04.1–04.2).
 *
 * The renderer never assembles history: main takes the persisted messages,
 * keeps the most recent rounds, enforces a token budget and always keeps the
 * current user question. UI labels ("已停止", "重试", …) live only in the
 * renderer and are never part of a message row, so they cannot leak here.
 */

import type {
  ChatContentPart,
  ChatImage,
  ChatMessage,
  MessageRole,
  MessageStatus
} from '../../shared/channels'

/** Minimal message shape accepted by the pure builder (unit-test friendly). */
export interface ContextMessage {
  role: MessageRole
  content: string
  status?: MessageStatus
  /** Clipboard images attached to a user message (never assistant rows). */
  images?: readonly ChatImage[]
}

export interface ContextTurnMessage {
  role: 'system' | 'user' | 'assistant'
  /** Plain text, or multimodal parts when the turn carries images. */
  content: string | ChatContentPart[]
}

export interface BuildContextOptions {
  /**
   * Chronological messages. The last `user` row is treated as the current
   * question; anything before it is history. The assistant placeholder for
   * the in-flight request must not be passed in.
   */
  messages: readonly ContextMessage[]
  /** M1 normally null; M2 may configure a session system prompt. */
  systemPrompt?: string | null
  /** How many user/assistant rounds to keep (default 12). */
  maxRounds?: number
  /** Estimated token budget (default 32k). */
  tokenBudget?: number
}

export interface BuiltContext {
  messages: ContextTurnMessage[]
  estimatedTokens: number
  /** True when at least one old round was dropped or the current question alone exceeds the budget. */
  trimmed: boolean
  droppedPairs: number
}

export const DEFAULT_CONTEXT_ROUNDS = 12
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 32_000

/**
 * Characters that map to the CJK ~`chars/2` token estimate: Han, Hiragana,
 * Katakana and Hangul. Everything else uses the ASCII ~`chars/4` estimate.
 */
const CJK_CHARACTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * Rough token estimate: CJK characters cost ~2 tokens per character (i.e.
 * `chars/2`) and everything else ~0.25 token per character (`chars/4`).
 * Rounded up so a message that is just above a boundary never looks free.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0

  let cjk = 0
  let other = 0
  for (const character of text) {
    if (CJK_CHARACTER.test(character)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 2 + other / 4)
}

export function estimateMessagesTokens(messages: readonly ContextTurnMessage[]): number {
  let total = 0
  for (const message of messages) total += estimateTurnTokens(message)
  return total
}

/**
 * Image cost is provider-dependent; ~1.1k tokens matches a 1024–1568px tile on
 * the common OpenAI-compatible gateways and keeps the budget conservative.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_100

export function estimateTurnTokens(message: ContextTurnMessage): number {
  if (typeof message.content === 'string') return estimateTokens(message.content)

  let total = 0
  let images = 0
  for (const part of message.content) {
    if (part.type === 'text') total += estimateTokens(part.text)
    else images += 1
  }
  return total + images * IMAGE_TOKEN_ESTIMATE
}

/** Assistant rows that can be shown to the model as prior answers. */
function isUsableAssistant(message: ContextMessage): boolean {
  if (message.content.trim().length === 0) return false
  // Missing status (unit-test fakes) means "complete".
  if (message.status === undefined) return true
  return (
    message.status === 'complete' ||
    message.status === 'stopped' ||
    message.status === 'interrupted'
  )
}

interface Round {
  user: ContextMessage
  assistants: ContextMessage[]
}

function toRoundMessages(round: Round, imageOwner: ContextMessage | null): ContextTurnMessage[] {
  const messages: ContextTurnMessage[] = [toUserTurn(round.user, round.user === imageOwner)]
  for (const assistant of round.assistants) {
    messages.push({ role: 'assistant', content: assistant.content })
  }
  return messages
}

/**
 * Only the latest image-bearing user turn is sent as multimodal parts. Older
 * attachments stay on disk (and in the UI) but are not re-uploaded on every
 * turn — otherwise a long screenshot session would cost 1k+ tokens per image
 * per request.
 */
function findImageOwner(
  messages: readonly ContextMessage[],
  currentUserIndex: number
): ContextMessage | null {
  for (let index = currentUserIndex >= 0 ? currentUserIndex : messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user' && (message.images?.length ?? 0) > 0) return message
  }
  return null
}

function toUserTurn(message: ContextMessage, withImages: boolean): ContextTurnMessage {
  const images = withImages ? message.images ?? [] : []
  if (images.length === 0) return { role: 'user', content: message.content }

  const parts: ChatContentPart[] = [{ type: 'text', text: message.content }]
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  return { role: 'user', content: parts }
}

/**
 * Assemble `[system?, …history, current user]`.
 *
 * History is grouped into rounds (a user row plus its following assistant
 * rows). Only the last `maxRounds` rounds are considered; then the oldest
 * rounds are dropped until the estimated token count fits `tokenBudget`.
 * The current user message is never dropped or truncated: if it alone exceeds
 * the budget the result is marked `trimmed` and the caller emits
 * `context_trimmed`.
 */
export function buildContext(options: BuildContextOptions): BuiltContext {
  const maxRounds = Math.max(0, Math.floor(options.maxRounds ?? DEFAULT_CONTEXT_ROUNDS))
  const tokenBudget = Math.max(1, Math.floor(options.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET))

  const messages = options.messages
  let currentUserIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'user') {
      currentUserIndex = index
      break
    }
  }

  const currentUser = currentUserIndex >= 0 ? messages[currentUserIndex] : null
  const historyEnd = currentUserIndex >= 0 ? currentUserIndex : messages.length
  const imageOwner = findImageOwner(messages, currentUserIndex)

  const rounds: Round[] = []
  for (let index = 0; index < historyEnd; index += 1) {
    const message = messages[index]
    if (message.role === 'system') continue
    if (message.role === 'user') {
      rounds.push({ user: message, assistants: [] })
      continue
    }
    if (rounds.length === 0) continue
    if (isUsableAssistant(message)) {
      rounds[rounds.length - 1].assistants.push(message)
    }
  }

  // Only the most recent N rounds are eligible; the rest are dropped up front.
  let droppedPairs = Math.max(0, rounds.length - maxRounds)
  const kept = maxRounds === 0 ? [] : rounds.slice(rounds.length - maxRounds)

  const systemPrompt = options.systemPrompt?.trim() ?? ''
  const systemMessage: ContextTurnMessage[] =
    systemPrompt.length > 0 ? [{ role: 'system', content: systemPrompt }] : []

  const currentMessages: ContextTurnMessage[] = currentUser
    ? [toUserTurn(currentUser, currentUser === imageOwner)]
    : []

  const countTokens = (): number =>
    estimateMessagesTokens(systemMessage) +
    estimateMessagesTokens(kept.flatMap((round) => toRoundMessages(round, imageOwner))) +
    estimateMessagesTokens(currentMessages)

  let estimatedTokens = countTokens()
  while (estimatedTokens > tokenBudget && kept.length > 0) {
    kept.shift()
    droppedPairs += 1
    estimatedTokens = countTokens()
  }

  const assembled = [
    ...systemMessage,
    ...kept.flatMap((round) => toRoundMessages(round, imageOwner)),
    ...currentMessages
  ]

  return {
    messages: assembled,
    estimatedTokens,
    // A single oversized current question is intentionally not truncated.
    trimmed: droppedPairs > 0 || estimatedTokens > tokenBudget,
    droppedPairs
  }
}

/** Convenience wrapper for the orchestrator (persisted rows). */
export function buildContextFromChatMessages(
  messages: readonly ChatMessage[],
  options: Omit<BuildContextOptions, 'messages'> = {}
): BuiltContext {
  return buildContext({
    ...options,
    messages: messages.map((message) => ({
      role: message.role,
      content: message.content,
      images: message.images,
      status: message.status
    }))
  })
}
