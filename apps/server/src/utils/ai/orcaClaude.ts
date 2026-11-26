import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "@toonflow/file";
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type Context, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { RequestHandler } from "express";
import { isMobileLinkRequest } from "@/utils/mobileLink";
import { isEnabled as multiTenantEnabled } from "@/utils/multiTenant/mode";
import { isOrcaClaudeProvider, orcaClaudeProvider } from "@/lib/orcaClaude";
import { maxOrcaBytes, orcaErrors, orcaEvent, orcaModelList, orcaModelsPath, orcaPort, orcaTextPath } from "@/lib/orcaClaudeProtocol";

const localRequest = new AsyncLocalStorage<{ canGenerate: boolean; catalog?: Promise<typeof orcaClaudeProvider> }>();
const unavailable = "无法连接本机 Orca 文本服务，请先启动 orcaClaudeHost";
export const orcaLocalRequest: RequestHandler = (req, res, next) => {
  const host = req.get("host");
  const origin = req.get("origin") ?? req.get("referer");
  const peer = req.socket.remoteAddress?.replace(/^::ffff:/, "");
  // Docker 只发布回环端口，转发后对端是该实例的网桥网关。
  const localPeer = !!peer && (["::1", "127.0.0.1"].includes(peer) || peer === process.env.TOONFLOW_ORCA_LOCAL_PEER);
  const allowed = localPeer && ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname)
    && (origin === `${req.protocol}://${host}` || origin?.startsWith(`${req.protocol}://${host}/`))
    && req.get("x-toonflow-workspace") === "1" && req.get("x-toonflow-local-client") !== "0"
    && !isMobileLinkRequest(req) && !res.locals.multiTenantWeb;
  if (!allowed) return next();
  localRequest.run({ canGenerate: req.method === "POST" }, next);
};

export function assertOrcaAccess() {
  if (!localRequest.getStore()?.canGenerate || multiTenantEnabled()) {
    throw Object.assign(new Error("请在本机 Toonflow 的独立模式中使用 Orca Claude"), { status: 403 });
  }
}

async function requestHost(path: string, init: RequestInit) {
  const keyPath = process.env.TOONFLOW_ORCA_KEY_FILE;
  const key = keyPath && (await readFile(keyPath, "utf8").catch(() => "")).trim();
  if (!key || !/^[a-f0-9]{64}$/.test(key)) throw new Error(unavailable);
  const host = process.env.TOONFLOW_ORCA_HOST === "host.docker.internal" ? "host.docker.internal" : "127.0.0.1";
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${key}`);
  const response = await fetch(`http://${host}:${orcaPort}${path}`, { ...init, headers, redirect: "error" }).catch(() => { throw new Error(unavailable); });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(unavailable); }
  return response;
}

async function readCatalog() {
  const response = await requestHost(orcaModelsPath, { signal: AbortSignal.timeout(12000) });
  const models = orcaModelList.parse(await response.json());
  const base = orcaClaudeProvider.models[0]!;
  return { ...orcaClaudeProvider, models: [base, ...models.filter(model => model.id !== base.id).map(model => ({ ...base, ...model }))] };
}

export function getOrcaClaudeProvider(required = false) {
  const request = localRequest.getStore();
  if (!request || multiTenantEnabled()) return Promise.resolve(orcaClaudeProvider);
  // 旧版或离线辅助进程继续提供原有的默认模型；同一请求中的设置和模型选择器共用目录。
  const catalog = request.catalog ??= readCatalog();
  return required ? catalog : catalog.catch(() => orcaClaudeProvider);
}

export async function withOrcaClaudeModels(providers: unknown) {
  if (!Array.isArray(providers) || !providers.some(isOrcaClaudeProvider)) return providers;
  const { models } = await getOrcaClaudeProvider();
  return providers.map(item => isOrcaClaudeProvider(item) ? { ...item, models } : item);
}

type Reference = { dataType: string; value: string };
function chatBody(modelId: string, context: Context, references: Reference[]) {
  const messages = context.messages.map(message => {
    if (typeof message.content === "string") return { role: message.role, text: message.content };
    const text = message.content.flatMap(part => {
      if (part.type === "image") throw new Error("Orca Claude 当前仅支持文本，请移除图片后重试");
      return part.type === "text" ? [part.text] : [];
    }).join("\n");
    return { role: message.role, text };
  });
  const user = messages.findLast(message => message.role === "user");
  if (!user) throw new Error("请先输入对话内容");
  for (const reference of references) {
    if (reference.dataType !== "STRING") throw new Error("Orca Claude 当前仅支持文本参考");
    user.text += `\n${reference.value}`;
  }
  const body = JSON.stringify({ modelId: modelId === "default" ? undefined : modelId, system: context.systemPrompt ?? "", messages });
  if (Buffer.byteLength(body) > maxOrcaBytes) throw new Error("对话过长，请压缩内容后重试");
  return body;
}

export function streamOrcaClaude(model: Model<Api>, context: Context, options?: SimpleStreamOptions, references: Reference[] = []) {
  const stream = createAssistantMessageEventStream();
  const text = { type: "text" as const, text: "" };
  const message: AssistantMessage = {
    role: "assistant", provider: model.provider, model: model.id, api: model.api, timestamp: Date.now(), stopReason: "stop", content: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    const timeout = AbortSignal.timeout(10 * 60 * 1000);
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    try {
      assertOrcaAccess();
      signal.throwIfAborted();
      const body = chatBody(model.id, context, references);
      const response = await requestHost(orcaTextPath, { method: "POST", headers: { "content-type": "application/json" }, body, signal });
      stream.push({ type: "start", partial: message });
      let pending = "";
      for await (const chunk of response.body!.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        let end: number;
        while ((end = pending.indexOf("\n")) !== -1) {
          const event = orcaEvent.parse(JSON.parse(pending.slice(0, end)));
          pending = pending.slice(end + 1);
          if (event.type === "error") throw new Error(orcaErrors[event.code]);
          if (event.type === "done") {
            const { input, output, cacheRead, cacheWrite } = event;
            Object.assign(message.usage, { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite });
            if (message.content.length) stream.push({ type: "text_end", contentIndex: 0, content: text.text, partial: message });
            message.stopReason = event.length ? "length" : "stop";
            stream.push({ type: "done", reason: message.stopReason, message });
            return;
          }
          if (!message.content.length) {
            message.content.push(text);
            stream.push({ type: "text_start", contentIndex: 0, partial: message });
          }
          text.text += event.text;
          stream.push({ type: "text_delta", contentIndex: 0, delta: event.text, partial: message });
        }
      }
      throw new Error("本机 Claude 的响应已中断，请重新发送");
    } catch (error) {
      message.stopReason = options?.signal?.aborted ? "aborted" : "error";
      message.errorMessage = options?.signal?.aborted ? "已停止生成" : timeout.aborted ? "本机 Claude 响应超时" : error instanceof Error ? error.message : unavailable;
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } finally { stream.end(); }
  })();
  return stream;
}
