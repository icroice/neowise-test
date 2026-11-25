import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = 3210;
const BASE = `http://127.0.0.1:${PORT}`;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

let server;

test.before(async () => {
  server = spawn(process.execPath, ["server.mjs"], {
    cwd: rootDir,
    env: { ...process.env, PORT: String(PORT) },
    stdio: "ignore",
  });
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await delay(100);
    }
  }
  throw new Error("сервер не поднялся за 5 с");
});

test.after(() => server?.kill());

async function post(body, headers = {}) {
  return fetch(`${BASE}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

test("успешный разбор: тема и непустой черновик", async () => {
  const reply = await post(JSON.stringify({ text: "Какова стоимость годовой подписки?" }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), {
    status: "ready",
    topic: "pricing",
    draft: "Спасибо за обращение. Уточним детали заявки.",
  });
});

test("пустой текст → 400 invalid_input", async () => {
  const reply = await post(JSON.stringify({ text: "   " }));
  assert.equal(reply.status, 400);
  assert.deepEqual(await reply.json(), { status: "invalid_input" });
});

test("отсутствующее поле text → 400 invalid_input", async () => {
  const reply = await post(JSON.stringify({}));
  assert.equal(reply.status, 400);
  assert.deepEqual(await reply.json(), { status: "invalid_input" });
});

test("битый JSON в запросе → 400 invalid_input", async () => {
  const reply = await post('{"text": "зая', {});
  assert.equal(reply.status, 400);
  assert.deepEqual(await reply.json(), { status: "invalid_input" });
});

test("ошибка модели → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[error] когда доставка?" }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
});

test("таймаут модели → 200 manual_review быстрее 1200 мс", async () => {
  const startedAt = Date.now();
  const reply = await post(JSON.stringify({ text: "[timeout] уточните детали" }));
  const elapsed = Date.now() - startedAt;
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
  assert.ok(elapsed < 1000, `ожидали < 1000 мс, получили ${elapsed} мс`);
});

test("битый JSON в ответе модели → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[bad-json] привет" }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
});

test("недопустимая тема → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[bad-topic] привет" }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
});

test("пустой черновик → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[empty-draft] привет" }));
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
});
