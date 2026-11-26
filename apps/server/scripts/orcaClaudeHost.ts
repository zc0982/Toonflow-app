import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "@toonflow/file";
import { z } from "zod";
import { latestOrcaClaudeModels, maxOrcaBytes, orcaCatalogModel, orcaEvent, orcaModelsPath, orcaPort, orcaRequest, orcaTextPath, type orcaErrors } from "../src/lib/orcaClaudeProtocol";

const exec = promisify(execFile);
const keyFile = process.env.TOONFLOW_ORCA_KEY_FILE || join(homedir(), ".config", "toonflow", "orcaClaude", "connection.key");
await mkdir(dirname(keyFile), { recursive: true, mode: 0o700 });
try {
  await writeFile(keyFile, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o400 });
  // 宿主目录仅本人可访问，容器只读挂载单个配对文件。
  await chmod(keyFile, 0o444);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const key = (await readFile(keyFile, "utf8")).trim();
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("本机 Toonflow 配对文件格式错误");
const authorization = Buffer.from(`Bearer ${key}`);
const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"].flatMap(name =>
  process.env[name] ? [[name, process.env[name]!]] : []));

class HostError extends Error {
  constructor(readonly code: keyof typeof orcaErrors) { super(code); }
}
type ChatEvent = z.infer<typeof orcaEvent>;
const accountList = z.object({ result: z.object({
  activeAccountId: z.string().nullish(), activeAccountIdsByRuntime: z.object({ host: z.string().nullish() }).optional(),
  accounts: z.array(z.object({
    id: z.string(), home: z.string(), email: z.string().nullish(), organizationUuid: z.string().nullish(),
    authMethod: z.string().nullish(), managedAuthRuntime: z.string().nullish(),
  })),
}) });

async function claudeEnvironment(signal: AbortSignal) {
  const options = { env, cwd: tmpdir(), timeout: 15000, maxBuffer: 1024 * 1024, signal, encoding: "utf8" as const };
  const inventory = await exec("orca", ["account", "list", "--agent", "claude", "--json"], options).catch(() => { throw new HostError("cli"); });
  const { result } = accountList.parse(JSON.parse(inventory.stdout));
  const accounts = result.accounts.filter(item => item.authMethod === "subscription-oauth" && item.managedAuthRuntime === "host");
  const active = result.activeAccountIdsByRuntime?.host ?? result.activeAccountId;
  const selected = active ? accounts.find(item => item.id === active) : accounts.length === 1 ? accounts[0] : undefined;
  if (!selected?.email || !isAbsolute(selected.home)) throw new HostError("account");
  const profileEnv = { ...env, CLAUDE_CONFIG_DIR: selected.home };
  // 只比较身份；Claude Code 自行读取和刷新凭据，宿主与容器均无须解析账号文件。
  const check = await exec("claude", ["--safe-mode", "auth", "status", "--json"], { ...options, env: profileEnv }).catch(() => { throw new HostError("identity"); });
  const login = JSON.parse(check.stdout);
  if (!login.loggedIn || login.authMethod !== "claude.ai" || login.email?.toLowerCase() !== selected.email.toLowerCase()
    || (selected.organizationUuid && login.orgId !== selected.organizationUuid)) throw new HostError("identity");
  return profileEnv;
}

const textFlags = [
  "--safe-mode", "-p", "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
  "--disable-slash-commands", "--no-session-persistence", "--output-format", "stream-json", "--verbose",
];
type ClaudeEnvironment = Awaited<ReturnType<typeof claudeEnvironment>>;
async function discoverModels(profileEnv: ClaudeEnvironment) {
  const requestId = randomUUID();
  // SDK 的 initialize 回复包含当前账号的模型菜单。只发送控制请求，无需生成文本。
  const child = exec("claude", [...textFlags, "--input-format", "stream-json"], {
    env: profileEnv, cwd: tmpdir(), encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  });
  child.child.stdin?.on("error", () => {});
  child.child.stdin?.end(JSON.stringify({ type: "control_request", request_id: requestId, request: { subtype: "initialize" } }) + "\n");
  const { stdout } = await child;
  for (const line of stdout.split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    if (item.type !== "control_response" || item.response?.request_id !== requestId || item.response.subtype !== "success") continue;
    const models = z.array(z.object({ value: z.string(), displayName: z.string() })).max(512).parse(item.response.response.models);
    const menu = models.flatMap(model => {
      const entry = orcaCatalogModel.safeParse({ id: model.value, label: model.displayName });
      return entry.success ? [entry.data] : [];
    });
    return latestOrcaClaudeModels.filter(({ id, alias, label }) => menu.some(item =>
      item.id === id || (item.id === alias && (item.label === label || item.label === `Claude ${label}`)),
    )).map(({ id, label }) => ({ id, label }));
  }
  throw new HostError("failed");
}

let catalog: { directory: string; expires: number; models: ReturnType<typeof discoverModels> } | undefined;
function supportedModels(profileEnv: ClaudeEnvironment) {
  const directory = profileEnv.CLAUDE_CONFIG_DIR;
  if (catalog?.directory === directory && catalog.expires > Date.now()) return catalog.models;
  const models = discoverModels(profileEnv).catch(error => {
    if (catalog?.models === models) catalog = undefined;
    throw error;
  });
  catalog = { directory, expires: Date.now() + 60_000, models };
  return models;
}

async function generate({ modelId, ...conversation }: z.infer<typeof orcaRequest>, signal: AbortSignal, send: (event: ChatEvent) => void) {
  const profileEnv = await claudeEnvironment(signal);
  if (!(await supportedModels(profileEnv)).some(model => model.id === modelId)) throw new HostError("model");
  signal.throwIfAborted();
  const child = spawn("claude", [
    ...textFlags, "--model", modelId, "--include-partial-messages",
    "--system-prompt", "你是 Toonflow 的文本助手。输入的 JSON 包含 Toonflow 的 system 设定和按时间排列的 messages。遵循设定和对话上下文，直接回答最后的用户消息。只输出回复正文。你只能生成文本。",
  ], { env: profileEnv, cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], signal });
  const ended = new Promise<number | null>(resolve => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {}); // 启动失败或被取消时，写管道会随子进程一起关闭。
  child.stdin.end(JSON.stringify(conversation));
  const terminate = () => {
    child.kill("SIGTERM");
    const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1500);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  };
  signal.addEventListener("abort", terminate, { once: true });
  let streamed = false;
  let done: Extract<ChatEvent, { type: "done" }> | undefined;
  try {
    for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
      signal.throwIfAborted();
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      const event = item.type === "stream_event" ? item.event : undefined;
      if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string" && event.delta.text) {
        streamed = true;
        send({ type: "text", text: event.delta.text });
      }
      if (item.type !== "result") continue;
      if (item.is_error || item.subtype !== "success") {
        throw new HostError(/rate.?limit|usage limit|hit your limit|quota|429/i.test(String(item.result)) ? "limit" : "failed");
      }
      if (!streamed && typeof item.result === "string" && item.result) send({ type: "text", text: item.result });
      const usage = item.usage ?? {};
      done = { type: "done", length: item.stop_reason === "max_tokens", input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
    }
    if (await ended !== 0 || !done) throw new HostError("failed");
    send(done);
  } finally {
    signal.removeEventListener("abort", terminate);
    if (child.exitCode === null && child.signalCode === null) terminate();
  }
}

let running = 0;
const server = createServer(async (req, res: ServerResponse) => {
  const auth = Buffer.from(req.headers.authorization ?? "");
  const listModels = req.method === "GET" && req.url === orcaModelsPath;
  const generateText = req.method === "POST" && req.url === orcaTextPath && req.headers["content-type"] === "application/json";
  if ((!listModels && !generateText) || req.headers.origin
    || auth.length !== authorization.length || !timingSafeEqual(auth, authorization)) { res.writeHead(403).end(); return; }
  const closed = new AbortController();
  res.once("close", () => closed.abort());
  const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(10 * 60 * 1000)]);
  if (listModels) {
    try {
      const models = await supportedModels(await claudeEnvironment(signal));
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(models));
    } catch { if (!res.destroyed) res.writeHead(503).end(); }
    return;
  }
  const send = (event: ChatEvent) => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
  if (running >= 4) { res.setHeader("Content-Type", "application/x-ndjson"); send({ type: "error", code: "busy" }); res.end(); return; }
  running++;
  try {
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > maxOrcaBytes) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let body;
    try { body = orcaRequest.parse(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
    catch { res.writeHead(400).end(); return; }
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
    res.flushHeaders();
    await generate(body, signal, send);
  } catch (error) {
    if (!signal.aborted) send({ type: "error", code: error instanceof HostError ? error.code : "failed" });
  } finally { running--; res.end(); }
});
server.listen(orcaPort, "127.0.0.1");
