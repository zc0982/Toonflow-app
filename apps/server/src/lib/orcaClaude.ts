// 本机供应商的设置只保存这份公开目录；登录由 Mac 上的 Orca 和 Claude Code 管理。
type OrcaClaudeModel = { id: string; label: string; reasoningEfforts: false; contextWindow: number; maxOutputTokens: number };

export const orcaClaudeProvider = {
  id: "orcaClaude", label: "Orca Claude", protocol: "orca-local" as const, apiUrl: "", apiKey: "",
  models: [] as OrcaClaudeModel[],
};

export const orcaClaudeVendor = {
  id: orcaClaudeProvider.id, name: orcaClaudeProvider.label, description: "使用本机 Orca 的 Claude 账号进行文本对话", updateTime: 0,
};

export function isOrcaClaudeProvider(value: { id?: unknown; protocol?: unknown } | null | undefined) {
  return value?.id === orcaClaudeProvider.id && value.protocol === orcaClaudeProvider.protocol;
}
