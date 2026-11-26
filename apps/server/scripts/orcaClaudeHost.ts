import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "@toonflow/file";
import { z } from "zod";
import { maxOrcaBytes, orcaEvent, orcaPort, orcaRequest, orcaTextPath, type orcaErrors } from "../src/lib/orcaClaudeProtocol";

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

async function generate(body: z.infer<typeof orcaRequest>, signal: AbortSignal, send: (event: ChatEvent) => void) {
  const profileEnv = await claudeEnvironment(signal);
  signal.throwIfAborted();
  const child = spawn("claude", [
    "--safe-mode", "-p", "--tools", "", "--permission-mode", "dontAsk", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--disable-slash-commands", "--no-session-persistence", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--system-prompt", "你是 Toonflow 的文本助手。输入的 JSON 包含 Toonflow 的 system 设定和按时间排列的 messages。遵循设定和对话上下文，直接回答最后的用户消息。只输出回复正文。你只能生成文本。",
  ], { env: profileEnv, cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"], signal });
  const ended = new Promise<number | null>(resolve => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  child.stdin.on("error", () => {}); // 启动失败或被取消时，写管道会随子进程一起关闭。
  child.stdin.end(JSON.stringify(body));
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
  if (req.method !== "POST" || req.url !== orcaTextPath || req.headers.origin || req.headers["content-type"] !== "application/json"
    || auth.length !== authorization.length || !timingSafeEqual(auth, authorization)) { res.writeHead(403).end(); return; }
  const closed = new AbortController();
  res.once("close", () => closed.abort());
  const signal = AbortSignal.any([closed.signal, AbortSignal.timeout(10 * 60 * 1000)]);
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
