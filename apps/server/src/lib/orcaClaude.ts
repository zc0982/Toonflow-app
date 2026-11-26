// 本机供应商的设置只保存这份公开目录；登录由 Mac 上的 Orca 和 Claude Code 管理。
export const orcaClaudeProvider = {
  id: "orcaClaude", label: "Orca Claude", protocol: "orca-local" as const, apiUrl: "", apiKey: "",
  models: [{ id: "default", label: "Claude（Orca 当前账号）", reasoningEfforts: false as const, contextWindow: 200000, maxOutputTokens: 32000 }],
};

export const orcaClaudeVendor = {
  id: orcaClaudeProvider.id, name: orcaClaudeProvider.label, description: "使用本机 Orca 的 Claude 账号进行文本对话", updateTime: 0,
};

export function isOrcaClaudeProvider(value: { id?: unknown; protocol?: unknown } | null | undefined) {
  return value?.id === orcaClaudeProvider.id && value.protocol === orcaClaudeProvider.protocol;
}
