#!/usr/bin/env node
/**
 * Gera o zip do Bac Bo Listas publicado no painel.
 * Saída: ../fbot-telegram/releases/
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const extDir = path.join(__dirname, "..");
const manifestPath = path.join(extDir, "manifest.json");
const outDir = path.resolve(__dirname, "../../fbot-telegram/releases");
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
