#!/usr/bin/env node
"use strict";
// App de exemplo: a unica coisa que faz e mostrar a versao instalada.
// A versao vem do version.json, que o auto-update sobrescreve.
const fs = require("fs");
const path = require("path");

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")).version;
  } catch {
    return "0.0.0";
  }
}

console.log("==================================");
console.log("  teste_repo - app de exemplo");
console.log("  versao instalada: v" + version());
console.log("  >> novidade da v1.3.0: atualizada pelo auto-updater!");
console.log("==================================");
