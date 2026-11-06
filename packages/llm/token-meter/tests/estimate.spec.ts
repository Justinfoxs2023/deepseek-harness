import { describe, expect, it } from 'vitest'
import { createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { canonicalHeader } from '@deepseek-ai/dsh-session'
import {
  estimateContent, estimateMessage, estimateStructuralBlock, estimateSystemMessage, estimateToolsTokens,
} from '../src/estimate.ts'

const SYSTEM_PLUGIN = '@deepseek-ai/dsh-system-prompt'

describe('token estimation density', () => {
  it('charges one token per wide character', () => {
    expect(estimateContent([{ type: 'text', text: '自动续跑按规则停止' }])).toBe(9 + 4)
  })

  it('shares one token between four non-wide characters', () => {
    expect(estimateContent([{ type: 'text', text: 'abcdefgh' }])).toBe(2 + 4)
  })

  it('mixes both densities in one text block', () => {
    // Two wide characters plus eight other characters: 2 + ceil(8 / 4).
    expect(estimateContent([{ type: 'text', text: '中文abcdefgh' }])).toBe(4 + 4)
  })

  it('prices kana, hangul, and fullwidth forms as wide characters', () => {
    expect(estimateContent([{ type: 'text', text: 'ひらがな' }])).toBe(4 + 4)
    expect(estimateContent([{ type: 'text', text: '한글' }])).toBe(2 + 4)
    expect(estimateContent([{ type: 'text', text: 'ＡＢ' }])).toBe(2 + 4)
  })

  it('prices a tool call name and arguments under the same densities', () => {
    expect(estimateContent([{ type: 'tool-call', id: 'c' as never, name: '读取', arguments: '{"path":"a"}' }])).toBe(2 + 3 + 4)
  })

  it('prices a structurally unknown block as wide-aware JSON', () => {
    const block = { type: 'custom', note: '中文' } as unknown as ContentBlock
    expect(estimateStructuralBlock(block)).toBe(4 + 9)
  })

  it('prices a system message as wide-aware text', () => {
    expect(estimateSystemMessage(createSystemMessage('中文提示', SYSTEM_PLUGIN))).toBe(4 + 4)
  })

  it('prices a system message with no content as zero', () => {
    expect(estimateSystemMessage(createSystemMessage('', SYSTEM_PLUGIN))).toBe(0)
  })

  it('prices tool schemas under the wide-aware density', () => {
    const header = canonicalHeader({
      config: { provider: 'minimax', model: 'MiniMax-M2.7' },
      tools: [{ name: '读取', description: '中文说明', parameters: { type: 'object', properties: {} } }],
    })
    expect(estimateToolsTokens(header)).toBeGreaterThan(0)
    expect(estimateToolsTokens(undefined)).toBe(0)
  })

  it('prices a message role with framing overhead', () => {
    expect(estimateMessage(createUserMessage({
      content: [{ type: 'text', text: '中文' }],
      source: { kind: 'user' },
    }))).toBe(2 + 4 + 4)
  })
})
