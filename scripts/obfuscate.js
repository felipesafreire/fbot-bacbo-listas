/**
 * Ofusca os .js de um diretório, em memória, antes de empacotar.
 *
 * Opções conservadoras: sem stringArray/selfDefending/controlFlowFlattening.
 * Essas transformações injetam uma função auxiliar no topo do arquivo e
 * fazem cada função do arquivo depender dela por closure. O código daqui
 * usa chrome.scripting.executeScript com `func:` e `.toString()` para
 * injetar funções isoladas direto na página (MAIN world) — só o texto da
 * função viaja, sem o resto do arquivo. Se a função dependesse de um
 * helper externo por closure, pararia de funcionar ao ser extraída assim.
 * Por isso a ofuscação aqui fica em renomear identificadores + compactar,
 * sem gerar dependências cruzadas entre funções do mesmo arquivo.
 */

const fs = require("fs");
const path = require("path");
const JavaScriptObfuscator = require("javascript-obfuscator");

const OBFUSCATOR_OPTIONS = {
  compact: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  stringArray: false,
  selfDefending: false,
  controlFlowFlattening: false,
  debugProtection: false,
  disableConsoleOutput: false,
  deadCodeInjection: false,
};

/**
 * Ofusca recursivamente todos os .js de `dir`, sobrescrevendo cada arquivo
 * no lugar. `exclude` é uma lista de caminhos relativos (prefixos) a pular
 * — por exemplo pastas de bibliotecas de terceiros (vendor/).
 */
function obfuscateDir(dir, { exclude = [] } = {}) {
  const files = listJsFiles(dir, dir, exclude);
  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const result = JavaScriptObfuscator.obfuscate(source, OBFUSCATOR_OPTIONS);
    fs.writeFileSync(file, result.getObfuscatedCode());
  }
  return files.length;
}

function listJsFiles(root, dir, exclude) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full);
    if (exclude.some((prefix) => rel === prefix || rel.startsWith(`${prefix}${path.sep}`))) {
      continue;
    }
    if (entry.isDirectory()) {
      out.push(...listJsFiles(root, full, exclude));
    } else if (entry.isFile() && full.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

module.exports = { obfuscateDir };
