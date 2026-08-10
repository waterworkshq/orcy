import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { ORCY_PATHS } from "@orcy/shared";
import type { InstallContext } from "./context.js";
import { backupFile } from "./writers/index.js";

export function generateSecret(length = 32): string {
  return randomBytes(length).toString("hex");
}

export interface EnvConfig {
  port: number;
  host: string;
}

export function generateEnvFile(ctx: InstallContext, config: EnvConfig): void {
  const envPath = path.join(ctx.orcyHome, ".env");

  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, "utf-8");
    const lines = existing.split("\n");
    const hadSecrets =
      lines.filter((l) => l.startsWith("JWT_SECRET=") || l.startsWith("ORCY_REGISTRATION_TOKEN="))
        .length >= 2;
    backupFile(envPath);
    const entries: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx > 0) entries[line.slice(0, idx)] = line.slice(idx + 1);
    }
    // Secrets are preserved — generated only if absent, never regenerated.
    if (!entries["JWT_SECRET"]) entries["JWT_SECRET"] = generateSecret(64);
    if (!entries["ORCY_REGISTRATION_TOKEN"])
      entries["ORCY_REGISTRATION_TOKEN"] = generateSecret(32);
    // Managed endpoint fields always reflect the install intent (G2H.1: an update
    // with a changed port/host must reach .env, not no-op because secrets exist).
    entries["PORT"] = String(config.port);
    entries["HOST"] = config.host;
    entries["ORCY_API_URL"] = `http://${config.host}:${config.port}`;
    if (!entries["LOG_LEVEL"]) entries["LOG_LEVEL"] = "info";
    if (!entries["NODE_ENV"]) entries["NODE_ENV"] = "production";
    const updated =
      Object.entries(entries)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") + "\n";
    fs.writeFileSync(envPath, updated, { mode: 0o600 });
    // Don't track .env in manifest — it's preserved on uninstall.
    console.log(
      hadSecrets
        ? "    Refreshed ~/.orcy/.env endpoint (secrets preserved)"
        : "    Updated existing .env with missing secrets",
    );
    return;
  }

  const content =
    [
      `PORT=${config.port}`,
      `HOST=${config.host}`,
      `JWT_SECRET=${generateSecret(64)}`,
      `ORCY_REGISTRATION_TOKEN=${generateSecret(32)}`,
      `ORCY_API_URL=http://${config.host}:${config.port}`,
      `LOG_LEVEL=info`,
      `NODE_ENV=production`,
    ].join("\n") + "\n";

  fs.mkdirSync(ctx.orcyHome, { recursive: true });
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  // Don't track .env in manifest — it's preserved on uninstall
  console.log("    Generated ~/.orcy/.env with secrets");
}

export function readRegistrationToken(): string | null {
  const envPath = ORCY_PATHS.envFile;
  if (!fs.existsSync(envPath)) return null;
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const idx = line.indexOf("=");
    if (idx > 0 && line.slice(0, idx) === "ORCY_REGISTRATION_TOKEN") {
      return line.slice(idx + 1).trim() || null;
    }
  }
  return null;
}
