import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Готовность ждём по «listening» из stdout самого потомка: если порт занят
  // чужим процессом, наш потомок умрёт с EADDRINUSE, и прогон упадёт с ясной
  // причиной вместо прогона против чужого слушателя.
  const started = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("сервер не поднялся за 5 с")), 5000);
    server.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`процесс сервера умер (code=${code}, signal=${signal}) — возможно, порт ${PORT} занят`));
    });
    server.stderr.on("data", () => {}); // сливаем stderr, чтобы буфер не переполнился
  });
  await started;
});

test.after(async () => {
  if (!server) return;
  server.kill();
  const exited = new Promise((resolve) => server.once("exit", resolve));
  const forceKill = setTimeout(() => server.kill("SIGKILL"), 1000); // на случай зависания при завершении
  await exited;
  clearTimeout(forceKill);
});

async function post(body, headers = {}) {
  return fetch(`${BASE}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

async function assertManualReview(reply) {
  assert.equal(reply.status, 200);
  assert.deepEqual(await reply.json(), { status: "manual_review", topic: null, draft: null });
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

test("нестроковый text → 400 invalid_input", async () => {
  for (const text of [123, true, null, ["доставка"]]) {
    const reply = await post(JSON.stringify({ text }));
    assert.equal(reply.status, 400, `ожидали 400 для text=${JSON.stringify(text)}`);
    assert.deepEqual(await reply.json(), { status: "invalid_input" });
  }
});

test("тело больше 1 МБ → 413 body_too_large", async () => {
  const reply = await post(JSON.stringify({ text: "а".repeat(2 * 1024 * 1024) }));
  assert.equal(reply.status, 413);
  assert.deepEqual(await reply.json(), { status: "body_too_large" });
});

test("битый JSON в запросе → 400 invalid_input", async () => {
  const reply = await post('{"text": "зая', {});
  assert.equal(reply.status, 400);
  assert.deepEqual(await reply.json(), { status: "invalid_input" });
});

test("ошибка модели → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[error] когда доставка?" }));
  await assertManualReview(reply);
});

test("таймаут модели → 200 manual_review быстрее 1000 мс", async () => {
  const startedAt = Date.now();
  const reply = await post(JSON.stringify({ text: "[timeout] уточните детали" }));
  const elapsed = Date.now() - startedAt;
  await assertManualReview(reply);
  assert.ok(elapsed < 1000, `ожидали < 1000 мс, получили ${elapsed} мс`);
});

test("битый JSON в ответе модели → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[bad-json] привет" }));
  await assertManualReview(reply);
});

test("недопустимая тема → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[bad-topic] привет" }));
  await assertManualReview(reply);
});

test("пустой черновик → 200 manual_review", async () => {
  const reply = await post(JSON.stringify({ text: "[empty-draft] привет" }));
  await assertManualReview(reply);
});
