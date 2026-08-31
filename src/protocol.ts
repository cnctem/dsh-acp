import { isAbsolute, resolve } from 'node:path'
import { RequestError } from '@agentclientprotocol/sdk'
import type { ContentBlock, PlanEntry, StopReason, ToolCallLocation, ToolKind } from '@agentclientprotocol/sdk'
import type { EncodedImageAttachment, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { TurnEndReason } from '@deepseek-ai/dsh-session'
import type { BridgeLogger } from './types.js'

export type ToolArguments = Record<string, unknown>

interface ToolResultBlock {
  type?: string
  toolCallId?: string
  isError?: boolean
  content?: readonly { type?: string; text?: string }[]
}

interface ToolResultMessage {
  content?: readonly ToolResultBlock[]
}

interface ImageAttachment {
  name?: string
  mediaType?: string
  width?: number
  height?: number
}

export interface TodoItem {
  content: string
  status: PlanEntry['status']
}

export interface SessionParams {
  cwd: string
  additionalDirectories?: readonly unknown[]
  mcpServers?: readonly unknown[]
}

export const MUTATING_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])

export function invalidParams(detail: string) {
  return RequestError.invalidParams(undefined, detail)
}

export function internalError(detail: string) {
  return RequestError.internalError(undefined, detail)
}

export function turnEndToStopReason(reason: TurnEndReason): StopReason {
  switch (reason.kind) {
    case 'completed':
      return 'end_turn'
    case 'max-tokens':
      return 'max_tokens'
    case 'aborted':
      return 'end_turn'
    case 'interrupted':
      return 'cancelled'
    case 'blocked':
    case 'error':
      return 'end_turn'
    default:
      return 'end_turn'
  }
}

export function acpPromptToText(prompt: readonly ContentBlock[]): string {
  return prompt
    .flatMap((block) => {
      switch (block.type) {
        case 'text':
          return [block.text]
        case 'resource_link':
          return [`\n[resource_link name=${JSON.stringify(block.name)} uri=${JSON.stringify(block.uri)}]\n`]
        default:
          return []
      }
    })
    .join('')
}

export function promptHasUnsupportedContent(prompt: readonly ContentBlock[]): boolean {
  return prompt.some((block) => block.type !== 'text' && block.type !== 'resource_link' && block.type !== 'image')
}

export function acpImagesToEncoded(prompt: readonly ContentBlock[]): EncodedImageAttachment[] {
  return prompt
    .filter((block) => block.type === 'image')
    .map((block) => ({ mediaType: block.mimeType as ImageMediaType, data: block.data }))
}

export function validateSessionParams(params: SessionParams, logger: Pick<BridgeLogger, 'debug'>): void {
  if (!isAbsolute(params.cwd)) throw invalidParams(`cwd must be an absolute path: ${params.cwd}`)
  if (params.additionalDirectories !== undefined && params.additionalDirectories.length > 0) {
    throw invalidParams('additionalDirectories is not supported')
  }
  if (params.mcpServers?.length) {
    logger.debug(`acp: ignoring ${params.mcpServers.length} client-configured MCP server(s); the bridge exposes no MCP tools`)
  }
}

export function isTerminalTool(name: string): boolean {
  return name === 'bash' || name === 'pwsh'
}

export function toToolKind(name: string): ToolKind {
  switch (name) {
    case 'read':
    case 'read_image':
    case 'glob':
    case 'grep':
      return 'read'
    case 'write':
    case 'edit':
    case 'str_replace_editor':
      return 'edit'
    case 'bash':
    case 'pwsh':
      return 'execute'
    default:
      return 'other'
  }
}

export function getToolPath(args: ToolArguments | undefined): string | undefined {
  if (typeof args?.path === 'string') return args.path
  if (typeof args?.file_path === 'string') return args.file_path
  return undefined
}

export function toolTitle(name: string, args: ToolArguments): string {
  if ((name === 'bash' || name === 'pwsh') && typeof args.command === 'string') {
    const command = args.command.trim()
    return command.length > 120 ? `${command.slice(0, 120)}…` : command
  }
  return name
}

export function toToolCallLocations(args: ToolArguments, cwd: string): ToolCallLocation[] | undefined {
  const path = getToolPath(args)
  if (path === undefined) return undefined
  return [{ path: isAbsolute(path) ? path : resolve(cwd, path) }]
}

export function getEditNeedle(name: string, args: ToolArguments): string | undefined {
  if (name === 'edit' && typeof args.old_string === 'string') return args.old_string
  if (name === 'str_replace_editor' && typeof args.old_str === 'string') return args.old_str
  return undefined
}

export function findUniqueLineNumber(text: string, needle: string | undefined): number | undefined {
  if (!needle) return undefined
  const first = text.indexOf(needle)
  if (first < 0 || text.indexOf(needle, first + needle.length) >= 0) return undefined
  let line = 1
  for (let index = 0; index < first; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1
  }
  return line
}

export function permissionLabel(name: string): string {
  switch (name) {
    case 'read-only':
      return 'Read only'
    case 'workspace-write':
      return 'Workspace write'
    case 'danger-full-access':
      return 'Full access'
    default:
      return name
  }
}

export function parseToolArguments(raw: string | undefined): ToolArguments {
  if (raw === undefined || raw.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' ? (parsed as ToolArguments) : { raw }
  } catch {
    return { raw }
  }
}

export function toolResultToText(message: ToolResultMessage | undefined): string {
  const block = message?.content?.[0]
  if (block?.type !== 'tool-result') return ''
  return (block.content ?? [])
    .filter((content): content is { type: 'text'; text: string } => content.type === 'text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('')
}

export function imageMarker(attachment: ImageAttachment | undefined): string {
  const reference = attachment ?? {}
  const dimensions =
    typeof reference.width === 'number' && typeof reference.height === 'number'
      ? `, ${reference.width}x${reference.height} px`
      : ''
  return `[image: ${reference.name ?? reference.mediaType ?? 'attachment'}${dimensions}]`
}

export function toPlanEntries(todos: readonly TodoItem[]): PlanEntry[] {
  return todos.map((todo) => ({ content: todo.content, priority: 'medium', status: todo.status }))
}
