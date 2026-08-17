// Heuristic detector for whether an LLM/model name advertises vision input.
//
// The agent backend ships images to the LLM as multimodal content blocks
// (see GenericAgent/agentmain.py:_build_user_content_with_images). Only
// vision-capable models will actually look at them; for text-only models
// the agent falls back to its file-based vision_api SOP — which is a much
// slower / less accurate path. So we surface a small badge on the picker
// to let the user know which mode they're in before they upload.
//
// We err on the side of *positive only when known* — a missed badge is
// cosmetic, but a wrongly-asserted "👁️ 视觉" would mislead users into
// expecting direct vision support that isn't there.

const PATTERNS: Array<RegExp> = [
  /claude-?3/i,                           // claude 3 family (sonnet/opus/haiku 3.5+ all see images)
  /sonnet|opus|haiku-?3\.[5-9]/i,         // bare names
  /gpt-?4o/i,                             // 4o
  /gpt-?4-?turbo/i,                       // 4-turbo (vision-capable variants)
  /gpt-?4-?vision/i,                      // legacy vision preview
  /gpt-?4\.[1-9]/i,                       // gpt-4.1+
  /gpt-?5/i,                              // future-proof
  /o[134]/i,                              // o1/o3/o4 — currently vision capable
  /gemini-?(1\.5|2|pro|flash)/i,          // 1.5+ all multimodal
  /qwen.*-?vl/i,                          // qwen-vl, qwen2-vl
  /qwen2?-?vision/i,
  /glm-?4v/i,                             // zhipu glm-4v
  /yi-?vl/i,                              // 01-ai yi-vl
  /llava/i,
  /cogvlm|cog-?vlm/i,
  /grok-?[2-9]/i,                         // grok 2+ multimodal
  /pixtral/i,                             // mistral pixtral
  /internvl/i,
]

export interface LLMCapability {
  multimodal: boolean
  reason?: string                  // matched pattern (for debugging / tooltip)
}

export interface LlmIdentity {
  key: string
  index?: number
}

export function defaultMainLlmKey(llms: ReadonlyArray<LlmIdentity>): string | undefined {
  return llms[0]?.key
}

/** Keep a durable main-model binding when it still exists; otherwise use the
 * first configured model. This is also the migration rule for old positional
 * bindings and for bindings whose model was deleted.
 */
export function resolveMainLlmKey(
  llms: ReadonlyArray<LlmIdentity>,
  llmKey: string | null | undefined,
): string | undefined {
  if (llmKey && llms.some((item) => item.key === llmKey)) {
    return llmKey
  }
  return defaultMainLlmKey(llms)
}

/** An invalid explicit subagent binding falls back to following the main
 * model. It must never drift to a neighbouring item after list changes.
 */
export function resolveSubagentLlmKey(
  llms: ReadonlyArray<LlmIdentity>,
  llmKey: string | null | undefined,
): string | null {
  return llmKey && llms.some((item) => item.key === llmKey) ? llmKey : null
}

/** Convert a durable key to the index expected by legacy runtime APIs. Always
 * use the latest LLM snapshot so reordering does not change model identity.
 */
export function llmIndexForKey(
  llms: ReadonlyArray<LlmIdentity>,
  llmKey: string | null | undefined,
): number | null {
  if (!llmKey) return null
  const position = llms.findIndex((item) => item.key === llmKey)
  if (position < 0) return null
  const configuredIndex = llms[position].index
  return Number.isInteger(configuredIndex) ? configuredIndex as number : position
}

// Live-chat sessions use the same main-model policy, with persistence owned by
// the session API instead of the shared non-session preference hook.
export const defaultSessionLlmKey = defaultMainLlmKey
export const resolveSessionLlmKey = resolveMainLlmKey

export function detectLLMCapability(name: string, model?: string): LLMCapability {
  const s = `${name || ''} ${model || ''}`
  for (const re of PATTERNS) {
    const m = re.exec(s)
    if (m) return { multimodal: true, reason: m[0] }
  }
  return { multimodal: false }
}

export function llmBadgeText(cap: LLMCapability): string {
  return cap.multimodal ? '👁️ 视觉' : '📝 文本'
}

export function llmBadgeTitle(cap: LLMCapability): string {
  return cap.multimodal
    ? '此模型支持直接读取图片（多模态）。粘贴图片会以 base64 形式发送给模型本体识别。'
    : '此模型仅文本。上传图片时 Agent 会改用 vision_api 工具旁路（更慢、依赖 memory/vision_api.py 配置）。'
}
