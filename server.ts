import app, { startServer } from "./api/_server.ts";

startServer({ development: process.argv.includes("--dev") }).catch((error) => {
  console.error("[EXU RESPONDE SERVER] Falha ao iniciar:", error);
  process.exitCode = 1;
});

export default app;