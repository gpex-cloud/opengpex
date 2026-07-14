// scripts/gen-plugin-types.mjs
// Generates `commands.d.ts` for plugin directories.
//
// Usage:
//   pnpm gen-plugin-types <plugin-dir>       — generate for a single plugin
//   pnpm gen-plugin-types --all              — batch generate for all plugins under plugins/base

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.join(__dirname, '..');

const PLUGINS_BASE = path.join(ROOT, 'src/lib/opengpex/plugins/base');

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function parseReturnType(genericStr) {
  if (!genericStr) return undefined;
  let depth = 0, splitIdx = -1;
  for (let i = 0; i < genericStr.length; i++) {
    if ('{<('.includes(genericStr[i])) depth++;
    else if ('}>)'.includes(genericStr[i])) depth--;
    else if (genericStr[i] === ',' && depth === 0) { splitIdx = i; break; }
  }
  if (splitIdx < 0) return undefined;
  const ret = genericStr.slice(splitIdx + 1).trim();
  return ret === 'void' ? undefined : ret;
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
  const reA = new RegExp(objKey + "\\s*:\\s*\\{[\\s\\S]*?id\\s*:\\s*(?:P\\.)?(\\w+|'[^']+')");
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

/**
 * Extract balanced generic content from a string starting at the given position.
 * e.g. for "EditorCommand<Partial<Config>, void>" starting after '<', returns "Partial<Config>, void"
 */
function extractBalancedGeneric(str, startIdx) {
  let depth = 0;
  let i = startIdx;
  while (i < str.length) {
    if (str[i] === '<') depth++;
    else if (str[i] === '>') {
      if (depth === 0) return str.slice(startIdx, i);
      depth--;
    }
    i++;
  }
  return str.slice(startIdx, i); // fallback
}

/**
 * Strip namespace prefixes (like "P.") from type strings.
 * "Partial<P.TabDockConfig>" → "Partial<TabDockConfig>"
 */
function stripNamespacePrefix(typeStr) {
  if (!typeStr) return typeStr;
  // Replace patterns like "P.TypeName" with just "TypeName"
  return typeStr.replace(/\b[A-Z_]\w*\./g, '');
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
        // Use balanced extraction for nested generics
        const castIdx = line.indexOf('as EditorCommand');
        if (castIdx >= 0 && currentKey) {
          const afterCast = line.slice(castIdx + 'as EditorCommand'.length);
          let genericStr = undefined;
          if (afterCast.startsWith('<')) {
            genericStr = extractBalancedGeneric(afterCast, 1);
          }
          commands.push({ objKey: currentKey, genericStr });
        }
        inEntry = false;
        currentKey = null;
      }
    }
  }

  // Pattern B: standalone const style
  if (commands.length === 0) {
    const castRe = /const\s+(\w+)\s*:\s*EditorCommand</g;
    let m;
    while ((m = castRe.exec(src)) !== null) {
      const genericStr = extractBalancedGeneric(src, m.index + m[0].length);
      commands.push({ objKey: m[1], genericStr: genericStr || undefined });
    }
    // Also try without generics
    if (commands.length === 0) {
      const simpleRe = /const\s+(\w+)\s*:\s*EditorCommand\s*=/g;
      while ((m = simpleRe.exec(src)) !== null) {
        commands.push({ objKey: m[1], genericStr: undefined });
      }
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

// ─── Core generation logic ──────────────────────────────────────────────────

function generateForPlugin(pluginDir) {
  const pluginName = path.basename(pluginDir);
  const commandsPath = path.join(pluginDir, 'commands.ts');
  const indexPath = fs.existsSync(path.join(pluginDir, 'index.tsx'))
    ? path.join(pluginDir, 'index.tsx') : path.join(pluginDir, 'index.ts');
  const protoPath = path.join(pluginDir, 'protocols.ts');

  const commands = extractCommands(commandsPath);
  const signals = extractSignals(indexPath, protoPath);

  if (commands.length === 0 && signals.length === 0) {
    return null; // nothing to generate
  }

  // Collect all type strings (payload + return, after namespace stripping) for import detection
  const allTypeStrings = commands.flatMap(cmd => {
    const p = stripNamespacePrefix(parsePayloadType(cmd.genericStr));
    const r = stripNamespacePrefix(parseReturnType(cmd.genericStr));
    return [p, r].filter(Boolean);
  });

  // Helper: check if a type name appears as a standalone identifier (word boundary match)
  function typeUsedIn(typeName, typeStr) {
    const re = new RegExp('\\b' + typeName + '\\b');
    return re.test(typeStr);
  }

  // Detect protocol type imports
  const protoTypeImports = new Set();
  if (fs.existsSync(protoPath)) {
    const protoSrc = fs.readFileSync(protoPath, 'utf-8');
    const typeExports = [...protoSrc.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)].map(m => m[1]);
    for (const ts of allTypeStrings) {
      for (const te of typeExports) {
        if (typeUsedIn(te, ts)) protoTypeImports.add(te);
      }
    }
  }

  // Detect command-local type imports (types exported from commands.ts itself)
  const cmdTypeImports = new Set();
  if (fs.existsSync(commandsPath)) {
    const cmdSrc = fs.readFileSync(commandsPath, 'utf-8');
    const typeExports = [...cmdSrc.matchAll(/export\s+(?:type|interface)\s+(\w+)/g)].map(m => m[1]);
    for (const ts of allTypeStrings) {
      for (const te of typeExports) {
        if (typeUsedIn(te, ts)) cmdTypeImports.add(te);
      }
    }
  }

  // Detect core type imports (types imported from @opengpex/editor/core/types in commands.ts)
  const coreTypeImports = new Set();
  if (fs.existsSync(commandsPath)) {
    const cmdSrc = fs.readFileSync(commandsPath, 'utf-8');
    const coreImportMatch = cmdSrc.match(/import\s+\{([^}]+)\}\s+from\s+['"]@opengpex\/editor\/core\/types['"]/);
    if (coreImportMatch) {
      const coreTypes = coreImportMatch[1].split(',').map(t => t.trim()).filter(Boolean);
      for (const ts of allTypeStrings) {
        for (const ct of coreTypes) {
          // Skip EditorCommand, EditorContextValue — those are internal, not needed in .d.ts
          if (ct === 'EditorCommand' || ct === 'EditorContextValue' || ct === 'AssetService') continue;
          if (typeUsedIn(ct, ts)) coreTypeImports.add(ct);
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
  for (const ct of coreTypeImports) coreImports.push(ct);
  L.push("import type { " + coreImports.join(', ') + " } from '@opengpex/editor/core/types';");
  if (protoTypeImports.size > 0) {
    L.push("import type { " + [...protoTypeImports].join(', ') + " } from './protocols';");
  }
  if (cmdTypeImports.size > 0) {
    L.push("import type { " + [...cmdTypeImports].join(', ') + " } from './commands';");
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
      const rawPayload = parsePayloadType(cmd.genericStr);
      const payload = stripNamespacePrefix(rawPayload);
      const rawReturn = parseReturnType(cmd.genericStr);
      const returnType = stripNamespacePrefix(rawReturn);
      if (payload && returnType) {
        L.push('  ' + keyName + ': CommandInstance<' + payload + ', ' + returnType + '>;');
      } else if (payload) {
        L.push('  ' + keyName + ': CommandInstance<' + payload + '>;');
      } else if (returnType) {
        L.push('  ' + keyName + ': CommandInstance<void, ' + returnType + '>;');
      } else {
        L.push('  ' + keyName + ': CommandInstance;');
      }
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

// ─── Discover all plugin dirs under plugins/base ────────────────────────────

function discoverPluginDirs() {
  const pluginDirs = [];
  if (!fs.existsSync(PLUGINS_BASE)) {
    console.error('Plugins base directory not found: ' + PLUGINS_BASE);
    process.exit(1);
  }
  // plugins/base has category subdirs (drawers, overlays, options, panels, backstage, xtends)
  // each category contains individual plugin directories
  const categories = fs.readdirSync(PLUGINS_BASE, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const cat of categories) {
    const catPath = path.join(PLUGINS_BASE, cat.name);
    const plugins = fs.readdirSync(catPath, { withFileTypes: true })
      .filter(d => d.isDirectory());
    for (const plug of plugins) {
      const plugPath = path.join(catPath, plug.name);
      // A valid plugin directory should have an index.ts or index.tsx
      if (fs.existsSync(path.join(plugPath, 'index.tsx')) ||
          fs.existsSync(path.join(plugPath, 'index.ts'))) {
        pluginDirs.push(plugPath);
      }
    }
  }
  return pluginDirs;
}

// ─── Main ───────────────────────────────────────────────────────────────────

const rawArg = process.argv[2];

if (!rawArg) {
  console.error('Usage:');
  console.error('  pnpm gen-plugin-types <plugin-dir>   — single plugin');
  console.error('  pnpm gen-plugin-types --all          — all plugins under plugins/base');
  process.exit(1);
}

if (rawArg === '--all') {
  // Batch mode: generate for all plugins
  const pluginDirs = discoverPluginDirs();
  let generated = 0;
  let skipped = 0;

  for (const dir of pluginDirs) {
    const output = generateForPlugin(dir);
    if (output) {
      const outputPath = path.join(dir, 'commands.d.ts');
      fs.writeFileSync(outputPath, output, 'utf-8');
      console.log('  ✓ ' + path.relative(ROOT, outputPath));
      generated++;
    } else {
      skipped++;
    }
  }

  console.log('');
  console.log(`Done. Generated: ${generated}, Skipped (no commands/signals): ${skipped}`);
} else {
  // Single plugin mode
  const pluginDir = path.resolve(ROOT, rawArg);
  if (!fs.existsSync(pluginDir)) {
    console.error('Plugin directory not found: ' + pluginDir);
    process.exit(1);
  }

  const output = generateForPlugin(pluginDir);
  if (output) {
    const outputPath = path.join(pluginDir, 'commands.d.ts');
    fs.writeFileSync(outputPath, output, 'utf-8');
    console.log('Generated ' + path.relative(ROOT, outputPath));
  } else {
    console.warn('No commands or signals found in ' + path.basename(pluginDir));
    process.exit(1);
  }
}
