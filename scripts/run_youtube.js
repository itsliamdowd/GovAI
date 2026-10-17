// Use the same .env loading convention as the app; never pass secrets on argv.
import { spawn } from "node:child_process";
try { process.loadEnvFile(); } catch (e) { if (e.code !== "ENOENT") throw e; }
const child = spawn(process.env.PYTHON || "python3", ["-m", "scripts.ingest_youtube", ...process.argv.slice(2)], {
  stdio: "inherit", env: process.env,
});
child.on("error", (e) => { console.error(`Could not start Python: ${e.message}`); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
