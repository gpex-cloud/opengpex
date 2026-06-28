// scripts/gen-plugin-types.mjs
// Generates `commands.d.ts` for a given plugin directory.
// Usage: pnpm gen-plugin-types <plugin-dir>

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const rawArg = process.argv[2];
if (!rawArg) {
  console.error('Usage: pnpm gen-plugin-types <plugin-dir>');
  process.exit(1);
}

const pluginDir = path.resolve(ROOT, rawArg);
if (!fs.existsSync(pluginDir)) {
  console.error('Plugin directory not found: ' + pluginDir);
  process.exit(1);
}

const pluginName = path.basename(pluginDir);

function toCamel(str) {
  return str.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
            .replace(/\.([a-z])/g, (_, c) => c.toUpperCase());
}
function cmdIdToKey(id) { return toCamel(id.replace(/^cmd\./, '')) + 'Cmd'; }
function signalIdToKey(id) { return toCamel(id.replace(/^signal\./, '')) + 'Signal'; }

function resolveConstant(constName, protoPath) {
  if (!fs.existsSync(protoPath)) return null;
  const src = fs.readFileSync(protoPath, 'utf-8');
  const re = new RegExp('export\\s+const\\s+' + constName + "\\s*=\\s*'([^']+)'");
  const m = src.match(re);
  return m ? m[1] : null;
}

function parsePayloadType(genericStr) {
  if (!genericStr) return undefined;
  let depth = 0, splitIdx = -1;
  for (let i = 0; i < genericStr.length; i++) {
    if ('{<('.includes(genericStr[i])) depth++;
    else if ('}>)'.includes(genericStr[i])) depth--;
    else if (genericStr[i] === ',' && depth === 0) { splitIdx = i; break; }
  }
  const payload = (splitIdx >= 0 ? genericStr.slice(0, splitIdx) : genericStr).trim();
  return payload === 'void' ? undefined : payload;
}

function inferTypeFromDefault(val) {
  if (val === 'null') return 'unknown';
  if (val === 'false' || val === 'true') return 'boolean';
  if (/^-?\d+(\.\d+)?$/.test(val)) return 'number';
  if (val.startsWith("'") || val.startsWith('"')) return 'string';
  return 'unknown';
}

function getCommandId(objKey, commandsPath, protoPath) {
  const src = fs.readFileSync(commandsPath, 'utf-8');
  // Pattern A: `key: { ... id: P.XXX }` (object property)
  const reA = new RegExp(objKey + "\\s*:\\s*\\{[\\s\\S]*?id\\s*:\\s*(?:P\\.)?(\\w+|'[^']+')");
  // Pattern B: `const varName ... = { ... id: P.XXX }` (standalone variable)
  const reB = new RegExp('(?:const|let)\\s+' + objKey + "[^=]*=\\s*\\{[\\s\\S]*?id\\s*:\\s*(?:P\\.)?(\\w+|'[^']+')");
  const m = src.match(reA) || src.match(reB);
  if (!m) return 'cmd.' + objKey;
  let idVal = m[1];
  if (!idVal.startsWith("'")) {
    const resolved = resolveConstant(idVal, protoPath);
    return resolved || ('cmd.' + idVal.replace(/^CMD_/, '').toLowerCase());
  }
  return idVal.replace(/'/g, '');
}

function extractCommands(commandsPath) {
  if (!fs.existsSync(commandsPath)) return [];
  const src = fs.readFileSync(commandsPath, 'utf-8');
  const commands = [];
  const lines = src.split('\n');
  let currentKey = null;
  let braceDepth = 0;
  let inEntry = false;

  for (const line of lines) {
    const keyMatch = line.match(/^\s+(\w+)\s*:\s*\{/);
    if (keyMatch && !inEntry) {
      currentKey = keyMatch[1];
      braceDepth = (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      inEntry = braceDepth > 0;
      continue;
    }
    if (inEntry) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth <= 0) {
        const castMatch = line.match(/as\s+EditorCommand(?:<([^>]*)>)?/);
        if (castMatch && currentKey) {
          commands.push({ objKey: currentKey, genericStr: castMatch[1] || undefined });
        }
        inEntry = false;
        currentKey = null;
      }
    }
  }

  // Pattern B: standalone const style `const varName: EditorCommand<T> = { ... };`
  if (commands.length === 0) {
    const constRe = /const\s+(\w+)\s*:\s*EditorCommand(?:<([^>]*)>)?\s*=/g;
    let m;
    while ((m = constRe.exec(src)) !== null) {
      commands.push({ objKey: m[1], genericStr: m[2] || undefined });
    }
  }

  return commands;
}



function extractSignals(indexPath, protoPath) {
  if (!fs.existsSync(indexPath)) return [];
  const src = fs.readFileSync(indexPath, 'utf-8');
  const signals = [];
  const signalsStart = src.indexOf('signals:');
  if (signalsStart === -1) return [];
  const region = src.slice(signalsStart, signalsStart + 2000);
  const blockRe = /\{\s*id\s*:\s*(?:P\.)?([\w.]+|'[^']+')\s*,[^}]*\}/gs;
  let match;
  while ((match = blockRe.exec(region)) !== null) {
    const block = match[0];
    const idMatch = block.match(/id\s*:\s*(?:P\.)?([\w.]+|'[^']+')/);
    if (!idMatch) continue;
    let signalId = idMatch[1];
    if (!signalId.startsWith("'")) {
      const resolved = resolveConstant(signalId, protoPath);
      if (resolved) signalId = resolved; else continue;
    } else {
      signalId = signalId.replace(/'/g, '');
    }
    if (!signalId.startsWith('signal.')) continue;
    const defMatch = block.match(/defaultValue\s*:\s*([^,}\s]+)/);
    const defaultValue = defMatch ? defMatch[1].trim() : 'null';
    signals.push({ signalId, defaultValue });
  }
  return signals;
}

function generate() {
  const commandsPath = path.join(pluginDir, 'commands.ts');
  const indexPath = fs.existsSync(path.join(pluginDir, 'index.tsx'))
    ? path.join(pluginDir, 'index.tsx') : path.join(pluginDir, 'index.ts');
  const protoPath = path.join(pluginDir, 'protocols.ts');

  const commands = extractCommands(commandsPath);
  const signals = extractSignals(indexPath, protoPath);

  if (commands.length === 0 && signals.length === 0) {
    console.warn('No commands or signals found in ' + pluginName);
    return null;
  }

  // Detect protocol type imports
  const protoTypeImports = new Set();
  if (fs.existsSync(protoPath)) {
    const protoSrc = fs.readFileSync(protoPath, 'utf-8');
    const typeExports = [...protoSrc.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)].map(m => m[1]);
    for (const cmd of commands) {
      const payload = parsePayloadType(cmd.genericStr);
      if (payload) {
        for (const te of typeExports) {
          if (payload.includes(te)) protoTypeImports.add(te);
        }
      }
    }
  }

  const L = [];
  L.push('/**');
  L.push(' * ' + pluginName + '/commands.d.ts \u2014 Auto-generated type declarations');
  L.push(' *');
  L.push(' * Provides compile-time type safety for usePluginCommands<T>()' + (signals.length > 0 ? ' and usePluginSignals<T>()' : '') + '.');
  L.push(' * Generated from commands.ts' + (signals.length > 0 ? ' and index signal declarations' : ' command declarations') + '.');
  L.push(' *');
  L.push(' * DO NOT EDIT MANUALLY \u2014 run `pnpm gen-plugin-types` to regenerate.');
  L.push(' */');
  L.push('');

  const coreImports = [];
  if (commands.length > 0) coreImports.push('CommandInstance');
  if (signals.length > 0) coreImports.push('InteractionSignalValue');
  L.push("import type { " + coreImports.join(', ') + " } from '@opengpex/editor/core/types';");
  if (protoTypeImports.size > 0) {
    L.push("import type { " + [...protoTypeImports].join(', ') + " } from './protocols';");
  }
  L.push('');

  if (commands.length > 0) {
    const mapName = pluginName + 'CommandsMap';
    L.push('/** Type map for usePluginCommands<' + mapName + '>() */');
    L.push('export interface ' + mapName + ' {');
    L.push('  [key: string]: { execute: (payload: never) => unknown; readonly name: string; readonly shortcutLabel: string };');
    for (const cmd of commands) {
      const cmdId = getCommandId(cmd.objKey, commandsPath, protoPath);
      const keyName = cmdIdToKey(cmdId);
      const payload = parsePayloadType(cmd.genericStr);
      L.push(payload
        ? '  ' + keyName + ': CommandInstance<' + payload + '>;'
        : '  ' + keyName + ': CommandInstance;');
    }
    L.push('}');
  }

  if (signals.length > 0) {
    L.push('');
    const mapName = pluginName + 'SignalsMap';
    L.push('/** Type map for usePluginSignals<' + mapName + '>() */');
    L.push('export interface ' + mapName + ' {');
    L.push('  [key: string]: { value: InteractionSignalValue; set: (val: InteractionSignalValue) => void };');
    for (const sig of signals) {
      const keyName = signalIdToKey(sig.signalId);
      const valueType = inferTypeFromDefault(sig.defaultValue);
      L.push('  ' + keyName + ': {');
      L.push('    value: ' + valueType + ';');
      L.push('    set: (val: ' + valueType + ') => void;');
      L.push('  };');
    }
    L.push('}');
  }

  L.push('');
  return L.join('\n');
}

const output = generate();
if (output) {
  const outputPath = path.join(pluginDir, 'commands.d.ts');
  fs.writeFileSync(outputPath, output, 'utf-8');
  console.log('Generated ' + path.relative(ROOT, outputPath));
} else {
  process.exit(1);
}
