import { describe, expect, test } from 'claude-code/testing'

import {
  PROMPT_HEAD,
  RESEARCH_TYPES,
  RESEARCH_WORDS,
  WRITING_TOOLS,
  isWritingTool,
  roleOf,
} from './role'

// C7a: the role a subagent box is titled with (PRD M-L1a), by the rule's
// three steps in order: the type, then the task words of the description
// and the prompt's head, then worker.

/** A task with no research word in it. */
const FIX = 'Fix the failing test'

describe('roleOf: the type', () => {
  test('the three read-only built-ins are researchers, whatever their task says', () => {
    expect(RESEARCH_TYPES).toEqual(['Explore', 'Plan', 'claude-code-guide'])

    for (const type of RESEARCH_TYPES) {
      expect(roleOf({ type, description: FIX }), type).toBe('researcher')
      expect(roleOf({ type, description: FIX, prompt: 'Edit the file and write the fix.' }), type).toBe('researcher')
    }
  })

  test('a type name holding explore, research, plan, review or guide, in any case, is a researcher', () => {
    for (const type of ['code-reviewer', 'deep-research', 'planner', 'docs-guide', 'EXPLORER', 'Security-Review']) {
      expect(roleOf({ type, description: FIX }), type).toBe('researcher')
    }

    for (const type of ['general-purpose', 'teammate', 'fork', 'test-runner', '']) {
      expect(roleOf({ type, description: FIX }), type).toBe('worker')
    }
  })
})

describe('roleOf: the task words', () => {
  test('a description holding any of the ten words, in any case, is a researcher', () => {
    expect(RESEARCH_WORDS).toEqual([
      'research',
      'search',
      'find',
      'explore',
      'investigate',
      'review',
      'audit',
      'read',
      'summarize',
      'compare',
    ])

    for (const word of RESEARCH_WORDS) {
      expect(roleOf({ type: 'general-purpose', description: `${word} the cache code` }), word).toBe('researcher')
      expect(roleOf({ type: 'general-purpose', description: `Then ${word.toUpperCase()} it.` }), word).toBe('researcher')
    }
  })

  test('whole words only: readme is not read, finder not find, reads not read; a hyphen or a stop ends a word', () => {
    for (const description of ['Update the README', 'Fix the finder', 'It reads the config', 'Researcher notes', 'Reviewed fixes', 'read_only flag']) {
      expect(roleOf({ type: 'general-purpose', description }), description).toBe('worker')
    }

    for (const description of ['A read-only check', 'Grep, then read.', '(search)', '调研代码 review']) {
      expect(roleOf({ type: 'general-purpose', description }), description).toBe('researcher')
    }
  })

  test('the default is worker: no research type, no task word in the description or the prompt', () => {
    expect(roleOf({ type: 'general-purpose', description: FIX })).toBe('worker')
    expect(roleOf({ type: 'general-purpose', description: FIX, prompt: 'Change the timeout to 30 s and run the suite.' })).toBe('worker')
    expect(roleOf({ type: 'general-purpose', description: '' })).toBe('worker')
    expect(roleOf({ type: 'general-purpose', description: '', prompt: '' })).toBe('worker')
  })
})

describe('roleOf: the prompt head', () => {
  /** A prompt whose first `length` characters hold no task word. */
  const filler = (length: number): string => 'x'.repeat(length)

  test('a task word in the first 200 characters of the prompt makes a researcher', () => {
    expect(PROMPT_HEAD).toBe(200)
    expect(roleOf({ type: 'general-purpose', description: FIX, prompt: 'Please find the slow query.' })).toBe('researcher')
    // The word ends at character 200 exactly.
    expect(roleOf({ type: 'general-purpose', description: FIX, prompt: `${filler(195)} read and more` })).toBe('researcher')
  })

  test('a word past character 200 is not read, nor a word the cut at 200 runs through', () => {
    // The word starts at character 201.
    expect(roleOf({ type: 'general-purpose', description: FIX, prompt: `${filler(199)} find the bug` })).toBe('worker')
    // `reading` runs from character 197 to 203: cut at 200 it would read `read`.
    expect(roleOf({ type: 'general-purpose', description: FIX, prompt: `${filler(195)} reading on` })).toBe('worker')
    // Characters, not UTF-16 units: 194 characters of two units each, then ` find` ends at character 199.
    expect(roleOf({ type: 'general-purpose', description: FIX, prompt: `${'𠀀'.repeat(194)} find it` })).toBe('researcher')
  })
})

describe('isWritingTool', () => {
  test('Edit, Write and NotebookEdit write files; Bash and every other tool do not', () => {
    expect(WRITING_TOOLS).toEqual(['Edit', 'Write', 'NotebookEdit'])

    for (const tool of WRITING_TOOLS) {
      expect(isWritingTool(tool), tool).toBe(true)
    }

    for (const tool of ['Bash', 'Read', 'Grep', 'Glob', 'Agent', 'edit', 'write', 'mcp__files__write_file', '']) {
      expect(isWritingTool(tool), tool).toBe(false)
    }
  })
})
