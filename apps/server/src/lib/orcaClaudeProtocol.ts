import { z } from "zod";

export const orcaPort = Number(process.env.TOONFLOW_ORCA_PORT ?? 43819);
if (!Number.isInteger(orcaPort) || orcaPort < 1 || orcaPort > 65535) throw new Error("TOONFLOW_ORCA_PORT 必须是 1–65535 之间的整数");
export const orcaTextPath = "/toonflow/text";
export const orcaModelsPath = "/toonflow/models";
export const maxOrcaBytes = 8 * 1024 * 1024;
const modelId = z.string().max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\[1m\])?$/);
export const orcaCatalogModel = z.object({ id: modelId, label: z.string().trim().min(1).max(200) });
export const orcaModelList = z.array(orcaCatalogModel).max(512);
// https://platform.claude.com/docs/en/models/overview
// Claude Code 菜单也可能返回系列别名。实际调用固定具体版本，避免别名按账号设置解析到旧型号。
export const latestOrcaClaudeModels = [
  { id: "claude-opus-5-5", label: "Opus 5.5", alias: "opus" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", alias: "sonnet" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", alias: "haiku" },
  { id: "claude-fable-5-2", label: "Fable 5.2", alias: "fable" },
];
export const orcaRequest = z.strictObject({
  modelId,
  system: z.string(),
  messages: z.array(z.strictObject({ role: z.enum(["user", "assistant", "toolResult"]), text: z.string() })).min(1),
});
export const orcaErrors = {
  account: "请在 Orca 中登录并选择一个本机 Claude 订阅账号",
  identity: "Claude Code 登录状态与 Orca 账号不一致，请在 Orca 中重新登录该账号",
  cli: "无法启动本机的 Orca 或 Claude Code，请检查安装和登录状态",
  limit: "Claude 账号已达使用限额，请稍后重试或在 Orca 中切换账号",
  failed: "Claude Code 未完成本次生成，请检查本机 Claude Code 的账号状态后重试",
  model: "所选模型不存在，请重新选择",
  busy: "本机 Claude 正在处理其他请求，请稍后重试",
};
export const orcaEvent = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("text"), text: z.string() }),
  z.strictObject({ type: z.literal("done"), length: z.boolean(), input: z.number().nonnegative(), output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative() }),
  z.strictObject({ type: z.literal("error"), code: z.enum(Object.keys(orcaErrors) as [keyof typeof orcaErrors, ...Array<keyof typeof orcaErrors>]) }),
]);
