#!/usr/bin/env node
/**
 * Gera o zip do Bac Bo Listas publicado no painel.
 * A pasta de saída vem de RELEASES_DIR no .env deste computador.
 *
 * Antes de zipar, copia a extensão para uma pasta temporária e ofusca o
 * JS próprio (ver scripts/obfuscate.js).
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { obfuscateDir } = require("./obfuscate");

const extDir = path.join(__dirname, "..");
const manifestPath = path.join(extDir, "manifest.json");

const EXCLUDED_TOP_LEVEL = new Set([
  "tests",
  "scripts",
  ".git",
  ".env",
  "CLAUDE.md",
  ".claude",
  "node_modules",
  "package.json",
  "package-lock.json",
]);

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

const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "fbot-listas-build-"));
try {
  fs.cpSync(extDir, buildDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(extDir, src);
      if (rel === "") return true;
      const top = rel.split(path.sep)[0];
      if (EXCLUDED_TOP_LEVEL.has(top)) return false;
      if (path.basename(src) === ".DS_Store") return false;
      return true;
    },
  });

  const obfuscated = obfuscateDir(buildDir, {});
  console.log(`Ofuscados ${obfuscated} arquivo(s) .js`);

  try {
    execFileSync("zip", ["-r", "-q", "-X", zipPath, "."], {
      cwd: buildDir,
      stdio: "inherit",
    });
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    execFileSync("tar", ["-a", "-c", "-f", zipPath, "."], {
      cwd: buildDir,
      stdio: "inherit",
    });
  }
} finally {
  fs.rmSync(buildDir, { recursive: true, force: true });
}

const meta = {
  version,
  file: "fbot-listas.zip",
  packaged_at: new Date().toISOString(),
};
fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

const bytes = fs.statSync(zipPath).size;
console.log(`Bac Bo Listas ${version} → ${zipPath} (${bytes} bytes)`);
