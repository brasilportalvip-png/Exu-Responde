import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

for (const variableName of [
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY"
]) {
  delete process.env[variableName];
}

const require = createRequire(import.meta.url);
const { default: app } = require("../dist/api.test.cjs");

test("a entrada serverless contém a aplicação sem depender de _server.ts", () => {
  assert.equal(typeof app, "function");
});

async function requestFromTemporaryServer(path, options) {
  const server = app.listen(0, "127.0.0.1");

  try {
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });

    const address = server.address();
    assert.ok(address && typeof address === "object");

    return await fetch(`http://127.0.0.1:${address.port}${path}`, options);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

test("a API inicia sem derrubar a função quando o Firebase Admin está ausente", async () => {
  const response = await requestFromTemporaryServer("/api/health");
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(typeof body.timestamp, "string");
});

test("o login devolve JSON controlado em vez de FUNCTION_INVOCATION_FAILED", async () => {
  const response = await requestFromTemporaryServer("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(typeof body.error, "string");
});

test("o health em produção rejeita status ok e devolve 503 degraded se o Firebase Admin estiver ausente", async () => {
  const prevEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    const response = await requestFromTemporaryServer("/api/health");
    const body = await response.json();

    assert.equal(response.status, 503);
    assert.equal(body.status, "degraded");
    assert.equal(body.services.firebaseAdmin, "unconfigured");
    assert.ok(Array.isArray(body.missingVariables));
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
});

test("o endpoint de recuperação de senha valida e responde com JSON controlado", async () => {
  const response = await requestFromTemporaryServer("/api/auth/reset-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "buscador@teste.com" })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(typeof body.message, "string");
});

test("os oráculos privados e caros exigem autenticação válida", async () => {
  const astroRes = await requestFromTemporaryServer("/api/oraculo/astrologia", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ birthDate: "1990-05-15" })
  });
  assert.equal(astroRes.status, 401);

  const buyRes = await requestFromTemporaryServer("/api/credits/buy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ planId: "prata" })
  });
  assert.equal(buyRes.status, 401);

  const adminRes = await requestFromTemporaryServer("/api/admin/users", {
    method: "GET"
  });
  assert.equal(adminRes.status, 401);
});

