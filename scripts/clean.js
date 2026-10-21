import fs from "fs";
import path from "path";

const targets = ["dist", "db.json"];

for (const target of targets) {
  const resolved = path.resolve(process.cwd(), target);
  if (fs.existsSync(resolved)) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true });
      console.log(`[CLEAN] Removido com sucesso: ${target}`);
    } catch (err) {
      console.error(`[CLEAN] Erro ao remover ${target}:`, err);
    }
  }
}
