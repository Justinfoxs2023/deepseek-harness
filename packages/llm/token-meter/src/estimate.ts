/**
 * Density-heuristic token pricing shared by the meter service and the
 * pure context-breakdown projection, so both surfaces price identical content
 * to identical numbers. Wide characters cost one token each and the remaining
 * characters share one token between four.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/**
 * Tokens one wide character costs under the fixed density heuristic. One wide
 * character is one token in practice, while a non-wide character shares a
 * token with three others, so a single density under-counts CJK transcripts
 * by about four times and hides the provider's own window pressure.
 */
const WIDE_TOKENS_PER_CHAR = 1

/** Non-wide characters that share one token under the fixed density heuristic. */
const NON_WIDE_CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/**
 * Whether one code point belongs to a script whose characters cost roughly one
 * token each.
 * @param code - Unicode code point of one character.
 * @returns true for CJK, Japanese kana, Hangul, and fullwidth forms.
 */
function isWideCharacter(code: number): boolean {
  return (code >= 0x3040 && code <= 0x30ff)
    || (code >= 0x3400 && code <= 0x4dbf)
    || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xff00 && code <= 0xffef)
}

/**
 * Price text under the fixed density heuristic, counting wide characters at
 * their own rate and the remaining characters at the shared rate.
 * @param text - text to price without mutation.
 * @returns heuristic tokens for the text.
 */
function estimateText(text: string): number {
  let wide = 0
  for (const character of text) {
    const code = character.codePointAt(0)
    if (code !== undefined && isWideCharacter(code)) wide += 1
  }
  return wide * WIDE_TOKENS_PER_CHAR + Math.ceil((text.length - wide) / NON_WIDE_CHARS_PER_TOKEN)
}

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * fixed heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed. Image offload marks do not
 * change this reference-only heuristic; route pricing owns their placeholders.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  if (block.type === 'image') {
    const { offloaded: _offloaded, ...reference } = block
    return BLOCK_OVERHEAD + estimateText(JSON.stringify(reference))
  }
  return BLOCK_OVERHEAD + estimateText(JSON.stringify(block))
}

/**
 * Price content blocks recursively under the fixed density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += estimateText(block.text) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += estimateText(block.name)
          + estimateText(block.arguments)
          + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Price the rendered system prompt: the `system/message` surface node's text.
 * Adapters serialize the prompt as a plain string — a system-role message or
 * the request's system field — not as a typed content block, so the price is
 * text density plus role framing with no per-block overhead.
 * @param message - system-role message to price without mutation.
 * @returns heuristic system-prompt tokens; 0 for empty content ("no system prompt").
 */
export function estimateSystemMessage(message: Message): number {
  if (message.content.length === 0) return 0
  let tokens = 0
  for (const block of message.content) {
    tokens += block.type === 'text' ? estimateText(block.text) : estimateText(JSON.stringify(block))
  }
  return tokens + ROLE_OVERHEAD
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic; a
 *   system-role message prices as {@link estimateSystemMessage}.
 */
export function estimateMessage(message: Message): number {
  if (message.role === 'system') return estimateSystemMessage(message)
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope — the envelope's
 * only priced field, since the system prompt is a surface node.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return estimateText(JSON.stringify(header.tools)) + BLOCK_OVERHEAD
}
