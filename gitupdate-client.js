#!/usr/bin/env node
"use strict";
/**
 * gitupdate-client - auto-updater UNIVERSAL para projetos distribuidos pelo
 * gitupdate-gateway (o mesmo gateway usado pelo git-mcp / git-autoupdate).
 *
 * Zero dependencias. Serve para QUALQUER projeto: basta ter um .gitupdate.json
 * na raiz (gerado por `git-autoupdate install`) contendo { endpoint, token }.
 *
 * O que faz:
 *   1. le o .gitupdate.json (endpoint do gateway + token read-only do cliente)
 *   2. consulta {endpoint}/v1/releases/latest
 *   3. compara a versao instalada (version.json / package.json / manifest)
 *      com a ultima release publicada
 *   4. se houver versao nova, baixa o pacote (um asset .zip da release, senao o
 *      source.zip da tag) e aplica por cima dos arquivos do app
 *
 * Uso:
 *   node gitupdate-client.js            # verifica e atualiza se houver versao nova
 *   node gitupdate-client.js --check    # so verifica, nao aplica
 *   node gitupdate-client.js --force    # reinstala a ultima versao mesmo se igual
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const https = require("https");
const http = require("http");

const APP_DIR = process.cwd();
const MANIFEST = path.join(APP_DIR, ".gitupdate.json");

// --------------------------------------------------------------- versao (semver)
function norm(v) {
  return String(v == null ? "0.0.0" : v).replace(/^v/i, "").trim();
}
function cmp(a, b) {
  const pa = norm(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = norm(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}
function readInstalledVersion(dir) {
  for (const f of ["version.json", "package.json"]) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (j && j.version) return j.version;
    } catch { /* ignora */ }
  }
  return "0.0.0";
}

// -------------------------------------------------------------------------- http
function resolveUrl(u, base) {
  if (/^https?:\/\//i.test(u)) return u;
  return base.replace(/\/+$/, "") + "/" + String(u).replace(/^\/+/, "");
}
function httpGet(url, token, as, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      { method: "GET", headers: { Authorization: "Bearer " + token, "User-Agent": "gitupdate-client" } },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirects >= 5) return reject(new Error("Muitos redirects"));
          return resolve(httpGet(resolveUrl(res.headers.location, u.origin), token, as, redirects + 1));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if (res.statusCode < 200 || res.statusCode >= 300) {
            return reject(new Error("HTTP " + res.statusCode + " em " + url + " :: " + body.toString("utf8").slice(0, 300)));
          }
          if (as === "json") {
            try { resolve(JSON.parse(body.toString("utf8"))); }
            catch (e) { reject(new Error("Resposta JSON invalida: " + e.message)); }
          } else {
            resolve(body);
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(120000, () => req.destroy(new Error("timeout na conexao com o gateway")));
    req.end();
  });
}

// --------------------------------------------------------------- ZIP (puro, nativo)
// Le o diretorio central do ZIP (fonte de verdade dos tamanhos/offsets) e
// descomprime cada entrada com zlib (deflate) ou copia direto (stored).
function parseZip(buf) {
  const EOCD = 0x06054b50;
  let eo = -1;
  const min = Math.max(0, buf.length - 22 - 65536);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eo = i; break; }
  }
  if (eo < 0) throw new Error("ZIP invalido: fim do diretorio central nao encontrado");
  const count = buf.readUInt16LE(eo + 10);
  let p = buf.readUInt32LE(eo + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("ZIP invalido: cabecalho central");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.push({ method, compSize, localOff, name });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function entryData(buf, e) {
  if (buf.readUInt32LE(e.localOff) !== 0x04034b50) throw new Error("ZIP invalido: cabecalho local");
  const nameLen = buf.readUInt16LE(e.localOff + 26);
  const extraLen = buf.readUInt16LE(e.localOff + 28);
  const start = e.localOff + 30 + nameLen + extraLen;
  const comp = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(comp);
  if (e.method === 8) return zlib.inflateRawSync(comp);
  throw new Error("Metodo de compressao ZIP nao suportado: " + e.method);
}
// Archives de release (source.zip) vem embrulhados em uma pasta raiz
// (ex: "teste_repo/"). Detecta e remove esse prefixo comum.
function detectStrip(entries) {
  const tops = new Set();
  for (const e of entries) tops.add(e.name.replace(/\\/g, "/").split("/")[0]);
  return tops.size === 1 ? 1 : 0;
}
function unzipInto(buf, outDir) {
  const entries = parseZip(buf);
  const strip = detectStrip(entries);
  const root = path.resolve(outDir);
  let count = 0;
  for (const e of entries) {
    let name = e.name.replace(/\\/g, "/");
    if (strip) name = name.split("/").slice(strip).join("/");
    if (!name) continue;
    const dest = path.resolve(outDir, name);
    // protecao contra zip-slip (entradas tentando escapar do destino)
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error("Entrada insegura no ZIP: " + e.name);
    if (name.endsWith("/")) { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entryData(buf, e));
    count++;
  }
  return count;
}

// ----------------------------------------------------------------------- arquivos
function copyOver(src, dst, skipTop) {
  for (const name of fs.readdirSync(src)) {
    if (skipTop && skipTop.has(name)) continue;
    const s = path.join(src, name);
    const d = path.join(dst, name);
    const st = fs.statSync(s);
    if (st.isDirectory()) { fs.mkdirSync(d, { recursive: true }); copyOver(s, d, null); }
    else fs.copyFileSync(s, d);
  }
}
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignora */ } }

// ---------------------------------------------------------------------------- main
async function main() {
  if (!fs.existsSync(MANIFEST)) {
    throw new Error(".gitupdate.json nao encontrado em " + APP_DIR + " (gere com `git-autoupdate install`).");
  }
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const endpoint = String(manifest.endpoint || "").replace(/\/+$/, "");
  const token = manifest.token;
  if (!endpoint) throw new Error("manifesto sem 'endpoint'.");
  if (!token) throw new Error("manifesto sem 'token'.");

  const checkOnly = process.argv.includes("--check");
  const force = process.argv.includes("--force");

  console.log("[gitupdate] projeto : " + (manifest.project || "(desconhecido)"));
  console.log("[gitupdate] gateway : " + endpoint);

  const latest = await httpGet(endpoint + "/v1/releases/latest", token, "json");
  const latestVer = norm(latest.tag);
  const current = norm(manifest.currentVersion || readInstalledVersion(APP_DIR));
  console.log("[gitupdate] instalada: v" + current + "   |   ultima: v" + latestVer);

  if (!force && cmp(latestVer, current) <= 0) {
    console.log("[gitupdate] ja esta na ultima versao.");
    return;
  }
  if (checkOnly) {
    console.log("[gitupdate] ha atualizacao disponivel (v" + latestVer + "). Modo --check: nada foi aplicado.");
    return;
  }

  // Fonte do pacote: um asset .zip da release; senao o source.zip da tag
  // (source.zip exige token com fullAccess).
  let url = null, isZip = false, fileName = null;
  const assets = Array.isArray(latest.assets) ? latest.assets : [];
  const zipAsset = assets.find((a) => /\.zip$/i.test(a.name || ""));
  if (zipAsset) { url = resolveUrl(zipAsset.downloadUrl, endpoint); isZip = true; }
  else if (assets.length) { url = resolveUrl(assets[0].downloadUrl, endpoint); fileName = assets[0].name; }
  else if (latest.sourceUrl) { url = resolveUrl(latest.sourceUrl, endpoint); isZip = true; }
  else throw new Error("Release v" + latestVer + " sem asset e sem source.zip acessivel (o token precisa de fullAccess).");

  console.log("[gitupdate] baixando : " + url);
  const data = await httpGet(url, token, "buffer");

  const tmp = path.join(APP_DIR, ".gitupdate-tmp-" + Date.now());
  fs.mkdirSync(tmp, { recursive: true });
  try {
    if (isZip) {
      const n = unzipInto(data, tmp);
      console.log("[gitupdate] extraidos " + n + " arquivo(s).");
    } else {
      fs.writeFileSync(path.join(tmp, fileName), data);
    }
    // Aplica por cima do app, preservando o proprio manifesto.
    copyOver(tmp, APP_DIR, new Set([".gitupdate.json", path.basename(tmp)]));
  } finally {
    rmrf(tmp);
  }

  manifest.currentVersion = latestVer;
  manifest.updatedAt = new Date().toISOString();
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log("[gitupdate] atualizado para v" + latestVer + " [OK]");
}

main().catch((e) => {
  console.error("[gitupdate] ERRO: " + (e && e.message ? e.message : e));
  process.exit(1);
});
