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

  assert.equal(response.status, 503);
  assert.equal(body.code, "FIREBASE_ADMIN_NOT_CONFIGURED");
  assert.deepEqual(body.missingEnvironmentVariables, [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY"
  ]);
});

test("o login devolve JSON controlado em vez de FUNCTION_INVOCATION_FAILED", async () => {
  const response = await requestFromTemporaryServer("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}"
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, "FIREBASE_ADMIN_NOT_CONFIGURED");
  assert.equal(typeof body.error, "string");
});