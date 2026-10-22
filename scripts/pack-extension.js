#!/usr/bin/env node
/**
 * Gera o zip do Bac Bo Listas publicado no painel.
 * A pasta de saída vem de RELEASES_DIR no .env deste computador.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const extDir = path.join(__dirname, "..");
const manifestPath = path.join(extDir, "manifest.json");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}

loadEnvFile(path.join(extDir, ".env"));

const releasesDir = String(process.env.RELEASES_DIR || "").trim();
if (!releasesDir) {
  console.error("Defina RELEASES_DIR no .env (veja .env.example).");
  process.exit(1);
}

const outDir = path.resolve(releasesDir);
const zipPath = path.join(outDir, "fbot-listas.zip");
const metaPath = path.join(outDir, "listas-release.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const version = String(manifest.version || "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error(`Versão inválida no manifest: ${version}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

try {
  execFileSync(
    "zip",
    [
      "-r",
      "-q",
      "-X",
      zipPath,
      ".",
      "-x",
      "tests/*",
      "tests/**",
      "scripts/*",
      ".git/*",
      ".env",
      ".env.*",
      "*.DS_Store",
    ],
    { cwd: extDir, stdio: "inherit" },
  );
} catch (err) {
  if (err.code !== "ENOENT") throw err;
  execFileSync(
    "tar",
    [
      "-a",
      "-c",
      "-f",
      zipPath,
      "--exclude=tests",
      "--exclude=scripts",
      "--exclude=.git",
      "--exclude=.env",
      "--exclude=.env.*",
      "--exclude=*.DS_Store",
      ".",
    ],
    { cwd: extDir, stdio: "inherit" },
  );
}

const meta = {
  version,
  file: "fbot-listas.zip",
  packaged_at: new Date().toISOString(),
};
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

const bytes = fs.statSync(zipPath).size;
console.log(`Bac Bo Listas ${version} → ${zipPath} (${bytes} bytes)`);
