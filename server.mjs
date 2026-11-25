import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { classify } from "./mock-ai.mjs";

const html = await readFile(new URL("./index.html", import.meta.url));

const port = Number(process.env.PORT || 3000);
const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 1_048_576; // 1 МБ: заявка — короткий текст, большее не принимаем
const ALLOWED_TOPICS = new Set(["delivery", "pricing", "other"]);

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function manualReview(response) {
  return json(response, 200, { status: "manual_review", topic: null, draft: null });
}

async function readBody(request) {
  const chunks = [];
  let received = 0;
  for await (const chunk of request) {
    received += chunk.length;
    if (received > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Вызов модели с ограничением по времени: имитатор поддерживает signal,
// поэтому по таймауту ожидание прерывается, а не висит до конца delay.
async function callModel(text) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
  try {
    return await classify(text, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseModelOutput(raw) {
  const { topic, draft } = JSON.parse(raw) ?? {};
  const topicOk = typeof topic === "string" && ALLOWED_TOPICS.has(topic);
  const draftOk = typeof draft === "string" && draft.trim() !== "";
  if (!topicOk || !draftOk) return null;
  return { topic, draft };
}

async function handleTriage(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch {
    // Тело при превышении лимита прочитано не до конца — сокет после ответа
    // закрываем, иначе клиент может переиспользовать его и получить обрыв.
    response.setHeader("Connection", "close");
    return json(response, 400, { status: "invalid_input" });
  }

  const { text } = payload ?? {};
  if (typeof text !== "string" || text.trim() === "") {
    return json(response, 400, { status: "invalid_input" });
  }

  let parsed;
  try {
    parsed = parseModelOutput(await callModel(text));
  } catch {
    return manualReview(response); // таймаут, ошибка модели или битый JSON в ответе
  }
  if (!parsed) {
    return manualReview(response); // неподходящая тема или пустой черновик
  }

  return json(response, 200, { status: "ready", ...parsed });
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/api/triage") {
    return json(response, 404, { status: "not_found" });
  }
  try {
    await handleTriage(request, response);
  } catch {
    json(response, 500, { status: "server_error" });
  }
}).listen(port, "127.0.0.1", () => console.log(`listening on http://127.0.0.1:${port}`));
