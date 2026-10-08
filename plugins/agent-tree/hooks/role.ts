// A subagent's role on the pane (PRD M-L1a): a researcher reads and reports,
// a worker changes things. Pure, no `$`: tree.ts gives a node its role when
// it opens it, from what the spawn or the agent list says, and turns it to
// worker for good at the node's first call of a tool that writes files.

import type { AgentRole } from '../types'

/** The read-only built-in agent types: researchers by definition. */
export const RESEARCH_TYPES: readonly string[] = ['Explore', 'Plan', 'claude-code-guide']

/** A type name holding one of these, in any case, is a researcher's (`code-reviewer`, `deep-research`). */
export const RESEARCH_TYPE_PARTS: readonly string[] = ['explore', 'research', 'plan', 'review', 'guide']

/** A task holding one of these as a whole word, in any case, is a researcher's (`Find the call sites`); `readme` is not `read`. */
export const RESEARCH_WORDS: readonly string[] = [
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
]

/** How many characters of the prompt's head the task words are looked for in. */
export const PROMPT_HEAD = 200

/** The tools that write files: the first call of one makes a subagent a worker for good. `Bash` is not one. */
export const WRITING_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit']

const TASK_WORDS = new RegExp(`\\b(?:${RESEARCH_WORDS.join('|')})\\b`, 'i')

/** What roleOf reads: the agent's type, the Agent call's description and, from a spawn, its prompt. */
export type RoleInput = {
  type: string
  description: string
  prompt?: string
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '')

/** The first PROMPT_HEAD characters of `prompt`, less the part of a word the cut runs through (`reading` cut to `read`). */
function promptHead(prompt: string): string {
  const characters = Array.from(prompt)

  if (characters.length <= PROMPT_HEAD) {
    return prompt
  }

  const head = characters.slice(0, PROMPT_HEAD).join('')

  return /\w/.test(characters[PROMPT_HEAD] ?? '') ? head.replace(/\w+$/, '') : head
}

/**
 * A subagent's role from what its spawn says (PRD M-L1a): a read-only
 * built-in type, or a type name holding a research part, is a researcher;
 * else a description, or a prompt head, holding a task word; else a worker.
 */
export function roleOf(input: RoleInput): AgentRole {
  const type = textOf(input.type)
  const name = type.toLowerCase()

  if (RESEARCH_TYPES.includes(type) || RESEARCH_TYPE_PARTS.some(part => name.includes(part))) {
    return 'researcher'
  }

  if (TASK_WORDS.test(textOf(input.description)) || TASK_WORDS.test(promptHead(textOf(input.prompt)))) {
    return 'researcher'
  }

  return 'worker'
}

/** Whether `tool` writes files: Edit, Write or NotebookEdit, by its exact name. */
export function isWritingTool(tool: string): boolean {
  return WRITING_TOOLS.includes(tool)
}
