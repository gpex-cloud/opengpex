// scripts/pack-plugin.mjs
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 1. Get CLI input arguments
const folderName = process.argv.find(arg => !arg.startsWith('-') && arg !== process.argv[0] && arg !== process.argv[1]);
const shouldMinify = process.argv.includes('--minify');

if (!folderName) {
  console.error('\n❌ [OpenGPEX Packager Error]: Please specify the plugin folder name.');
  console.error('Usage: node scripts/pack-plugin.mjs <PluginFolderName> [--minify]\n');
  process.exit(1);
}

const BASE_USER_PLUGINS_DIR = path.join(__dirname, '../src/lib/opengpex/plugins/user');
const pluginSourceDir = path.join(BASE_USER_PLUGINS_DIR, folderName);

if (!fs.existsSync(pluginSourceDir) || !fs.statSync(pluginSourceDir).isDirectory()) {
  console.error(`\n❌ [OpenGPEX Packager Error]: Plugin directory does not exist: "${pluginSourceDir}"\n`);
  process.exit(1);
}

// 2. Detect entry file
const entryFile = fs.existsSync(path.join(pluginSourceDir, 'index.tsx')) 
  ? path.join(pluginSourceDir, 'index.tsx') 
  : path.join(pluginSourceDir, 'index.ts');

if (!fs.existsSync(entryFile)) {
  console.error(`\n❌ [OpenGPEX Packager Error]: Entry file index.ts(x) not found in: "${pluginSourceDir}"\n`);
  process.exit(1);
}

// Helper: recursively copy a directory
function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Helper: evaluate raw variable value or literal value from files recursively
function evaluateValue(rawValue, currentFilePath, folderPath) {
  const literalMatch = rawValue.match(/^['"`]([^'"`]+)['"`]$/);
  if (literalMatch) {
    return literalMatch[1];
  }

  const dotParts = rawValue.split('.');
  const variableName = dotParts[dotParts.length - 1];

  if (!fs.existsSync(currentFilePath)) return null;
  const fileContent = fs.readFileSync(currentFilePath, 'utf-8');

  // Local definition search
  const localDefRegex = new RegExp("(?:const|let|var|function)\\s+" + variableName + "\\s*=\\s*['\"`]([^'\"`]+)['\"`]");
  const localDefMatch = fileContent.match(localDefRegex);
  if (localDefMatch) {
    return localDefMatch[1];
  }

  // Named import search
  const namedImportRegex = new RegExp("import\\s+\\{[^\\}]*" + variableName + "[^\\}]*\\}\\s+from\\s+['\"`]([^'\"`]+)['\"`]");
  const namedImportMatch = fileContent.match(namedImportRegex);
  if (namedImportMatch) {
    return resolveImportValue(namedImportMatch[1], variableName, folderPath);
  }

  // Namespace import search
  if (dotParts.length === 2) {
    const importNamespace = dotParts[0];
    const nsImportRegex = new RegExp("import\\s+\\*\\s+as\\s+" + importNamespace + "\\s+from\\s+['\"`]([^'\"`]+)['\"`]");
    const nsImportMatch = fileContent.match(nsImportRegex);
    if (nsImportMatch) {
      return resolveImportValue(nsImportMatch[1], variableName, folderPath);
    }
  }

  // Default import search
  if (dotParts.length === 2) {
    const importDefault = dotParts[0];
    const defaultImportRegex = new RegExp("import\\s+" + importDefault + "\\s+from\\s+['\"`]([^'\"`]+)['\"`]");
    const defaultImportMatch = fileContent.match(defaultImportRegex);
    if (defaultImportMatch) {
      return resolveImportValue(defaultImportMatch[1], variableName, folderPath);
    }
  }

  return null;
}

// Helper: resolve imports pointing to other files and evaluate
function resolveImportValue(importPath, variableName, folderPath) {
  let targetPath = path.resolve(folderPath, importPath);
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  let foundPath = '';
  
  if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
    foundPath = targetPath;
  } else {
    for (const ext of extensions) {
      if (fs.existsSync(targetPath + ext)) {
        foundPath = targetPath + ext;
        break;
      }
    }
  }

  if (!foundPath) return null;
  return evaluateValue(variableName, foundPath, path.dirname(foundPath));
}

// Helper: extract the manifest block string from file content
function extractManifestObjectString(content) {
  const startIdx = content.search(/manifest\s*:\s*\{/);
  if (startIdx === -1) return null;
  
  const openingBraceIdx = content.indexOf('{', startIdx);
  if (openingBraceIdx === -1) return null;
  
  let depth = 1;
  let i = openingBraceIdx + 1;
  while (i < content.length && depth > 0) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') depth--;
    i++;
  }
  
  if (depth === 0) {
    return content.substring(openingBraceIdx, i);
  }
  return null;
}

// Helper: parse JS object literal into key-value raw strings
function parseObjectLiteral(str) {
  const content = str.trim().substring(1, str.trim().length - 1).trim();
  const result = {};
  
  let i = 0;
  while (i < content.length) {
    while (i < content.length && (/\s/.test(content[i]) || content[i] === ',')) {
      i++;
    }
    if (i >= content.length) break;
    
    let key = '';
    if (content[i] === "'" || content[i] === '"') {
      const quote = content[i];
      i++;
      while (i < content.length && content[i] !== quote) {
        key += content[i];
        i++;
      }
      i++;
    } else {
      while (i < content.length && /[a-zA-Z0-9_]/.test(content[i])) {
        key += content[i];
        i++;
      }
    }
    
    while (i < content.length && content[i] !== ':') {
      i++;
    }
    i++; // skip colon
    
    let value = '';
    let braceDepth = 0;
    let bracketDepth = 0;
    let quoteChar = null;
    
    while (i < content.length) {
      const char = content[i];
      
      if (quoteChar) {
        if (char === quoteChar && content[i - 1] !== '\\') {
          quoteChar = null;
        }
        value += char;
        i++;
        continue;
      }
      
      if (char === "'" || char === '"' || char === '`') {
        quoteChar = char;
        value += char;
        i++;
        continue;
      }
      
      if (char === '{') braceDepth++;
      if (char === '}') braceDepth--;
      if (char === '[') bracketDepth++;
      if (char === ']') bracketDepth--;
      
      if (braceDepth === 0 && bracketDepth === 0 && (char === ',' || char === '\n' || char === '\r')) {
        break;
      }
      
      value += char;
      i++;
    }
    
    if (key) {
      result[key.trim()] = value.trim();
    }
  }
  return result;
}

// Helper: resolve variable, literal, or nested object values recursively
function resolveValue(valStr, currentFilePath, folderPath) {
  valStr = valStr.trim();
  if (!valStr) return null;
  
  const literalMatch = valStr.match(/^['"`]([^'"`]+)['"`]$/);
  if (literalMatch) {
    return literalMatch[1];
  }
  
  if (valStr === 'true') return true;
  if (valStr === 'false') return false;
  if (valStr === 'null') return null;
  if (!isNaN(valStr)) return Number(valStr);
  
  if (valStr.startsWith('{') && valStr.endsWith('}')) {
    const parsedObj = parseObjectLiteral(valStr);
    const resolvedObj = {};
    for (const [k, v] of Object.entries(parsedObj)) {
      resolvedObj[k] = resolveValue(v, currentFilePath, folderPath);
    }
    return resolvedObj;
  }
  
  const resolved = evaluateValue(valStr, currentFilePath, folderPath);
  if (resolved !== null) {
    return resolved;
  }
  
  return valStr;
}

console.log(`\n📦 [OpenGPEX Packager] Packaging plugin: "${folderName}"`);
console.log(`📂 Entry file: ${entryFile}`);

// 3. Extract plugin Manifest metadata
const entryContent = fs.readFileSync(entryFile, 'utf-8');
const manifestStr = extractManifestObjectString(entryContent);

if (!manifestStr) {
  console.error(`\n❌ [OpenGPEX Packager Error]: 'manifest' block not found in entry file: "${entryFile}"\n`);
  process.exit(1);
}

const parsedManifest = parseObjectLiteral(manifestStr);
const resolvedManifest = {};
for (const [k, v] of Object.entries(parsedManifest)) {
  resolvedManifest[k] = resolveValue(v, entryFile, pluginSourceDir);
}

if (!resolvedManifest.id || !resolvedManifest.author) {
  console.error(`\n❌ [OpenGPEX Packager Error]: Plugin manifest is missing required fields 'id' or 'author'.`);
  console.error(`Both fields must be explicitly specified in your entry file's manifest object.\n`);
  process.exit(1);
}

const rawAuthor = resolvedManifest.author;
// const author = rawAuthor.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
const pluginId = resolvedManifest.id;

// 🛡️ Prohibit bundling of base-prefixed illegal namespaces
if (pluginId.startsWith('base.') || pluginId.startsWith('com.gpex.plugins.base.')) {
  console.error(`\n❌ [OpenGPEX Security Block]: Dynamic plugins are forbidden to use official base namespaces: "${pluginId}".\n`);
  process.exit(1);
}

const manifest = {
  ...resolvedManifest,
  id: pluginId,
  displayName: resolvedManifest.displayName || folderName,
  version: resolvedManifest.version || '1.0.0',
  description: resolvedManifest.description || 'User-installed plugin.',
  category: resolvedManifest.category || 'user',
  author: rawAuthor
};

console.log(`🆔 Plugin ID: ${manifest.id}`);
console.log(`🏷️ Version: ${manifest.version}`);

// 4. Create packing temporary directory
const tempDir = path.join(__dirname, `../temp_pack_${Date.now()}`);
const tempDistDir = path.join(tempDir, 'dist');
fs.mkdirSync(tempDistDir, { recursive: true });

// Write the standard manifest file plugin.manifest
fs.writeFileSync(path.join(tempDir, 'plugin.manifest'), JSON.stringify(manifest, null, 2), 'utf-8');

try {
  // 5. 🚀 Bundle with esbuild speed, and externalize public React dependencies (Externalize)
  console.log(`⚡ Running esbuild compilation${shouldMinify ? ' (minified)' : ''}...`);
  const esbuildOutFile = path.join(tempDistDir, 'index.js');
  
  // Run pnpm dlx esbuild command line
  // Use --jsx=transform to force classic JSX transform (React.createElement), avoiding react/jsx-runtime bare specifier
  execSync(
    `pnpm dlx esbuild "${entryFile}" ` +
    `--bundle ` +
    `--format=esm ` +
    `--jsx=transform ` +
    (shouldMinify ? `--minify ` : '') +
    `--external:react ` +
    `--external:react-dom ` +
    `--external:lucide-react ` +
    `--external:@opengpex/editor/* ` +
    `--outfile="${esbuildOutFile}"`,
    { stdio: 'inherit' }
  );

  // Post-process: Replace bare specifier imports with window.__GPEX__ global variable references
  // This allows browsers to execute the ESM directly without an import map
  console.log('🔧 Post-processing: rewriting external imports to globals...');
  let jsContent = fs.readFileSync(esbuildOutFile, 'utf-8');

  // Regex patterns for ESM import forms produced by esbuild:
  // 1. import X from "pkg"
  // 2. import { A, B as C } from "pkg"
  // 3. import * as X from "pkg"
  // 4. import X, { A, B } from "pkg"  (default + named)
  // 5. import "pkg"  (side-effect only)

  const EXTERNAL_PKGS = ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'lucide-react'];
  const isExternal = (pkg) => EXTERNAL_PKGS.includes(pkg) || pkg.startsWith('@opengpex/editor/');

  // Match all import statements with their specifiers
  const importRegex = /^import\s+(.+?)\s+from\s+["']([^"']+)["']\s*;?\s*$/gm;
  const sideEffectRegex = /^import\s+["']([^"']+)["']\s*;?\s*$/gm;

  // Replace side-effect imports for externals (just remove them)
  jsContent = jsContent.replace(sideEffectRegex, (match, pkg) => {
    if (isExternal(pkg)) return `/* [GPEX] side-effect import removed: ${pkg} */`;
    return match;
  });

  // Replace import ... from "pkg" statements
  jsContent = jsContent.replace(importRegex, (match, importClause, pkg) => {
    if (!isExternal(pkg)) return match;

    const g = `window.__GPEX__["${pkg}"]`;
    const parts = [];

    // Check for "default, { named }" pattern
    const comboMatch = importClause.match(/^(\w+)\s*,\s*\{([^}]*)\}$/);
    if (comboMatch) {
      const defaultName = comboMatch[1].trim();
      const namedPart = comboMatch[2].trim();
      parts.push(`var ${defaultName} = ${g}.default || ${g};`);
      if (namedPart) {
        // Convert "A as B" to "A: B"
        const converted = namedPart.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
        parts.push(`var { ${converted} } = ${g};`);
      }
      return parts.join('\n');
    }

    // Namespace import: import * as X from "pkg"
    const nsMatch = importClause.match(/^\*\s+as\s+(\w+)$/);
    if (nsMatch) {
      return `var ${nsMatch[1]} = ${g};`;
    }

    // Named imports only: import { A, B as C } from "pkg"
    const namedMatch = importClause.match(/^\{([^}]*)\}$/);
    if (namedMatch) {
      const converted = namedMatch[1].trim().replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2');
      return `var { ${converted} } = ${g};`;
    }

    // Default import only: import X from "pkg"
    const defaultMatch = importClause.match(/^(\w+)$/);
    if (defaultMatch) {
      return `var ${defaultMatch[1]} = ${g}.default || ${g};`;
    }

    // Fallback: leave as-is (shouldn't happen)
    return match;
  });

  fs.writeFileSync(esbuildOutFile, jsContent, 'utf-8');
  console.log('✅ External imports rewritten to window.__GPEX__ globals.');

  const cssFile = path.join(pluginSourceDir, 'index.css');
  if (fs.existsSync(cssFile)) {
    console.log('🎨 Copying stylesheet index.css...');
    fs.copyFileSync(cssFile, path.join(tempDistDir, 'index.css'));
  }

  // 5.5 📁 Automatically copy all non-code subdirectories in the plugin directory as resources (regardless of directory name)
  const EXCLUDED_ENTRIES = new Set(['node_modules', 'dist', '.git', '.DS_Store']);
  // const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
  const pluginEntries = fs.readdirSync(pluginSourceDir, { withFileTypes: true });
  for (const entry of pluginEntries) {
    if (!entry.isDirectory()) continue;
    if (EXCLUDED_ENTRIES.has(entry.name)) continue;
    // Copy any subdirectory as a resource directory
    const srcDir = path.join(pluginSourceDir, entry.name);
    const destDir = path.join(tempDir, entry.name);
    console.log(`📁 Copying resource directory: ${entry.name}/`);
    copyDirRecursive(srcDir, destDir);
  }

  // 7. 🗜️ Compress the temporary folder as a ZIP archive to the dist directory
  const distDir = path.join(__dirname, '../dist');
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const zipName = `user-plugin-${folderName.toLowerCase()}-${manifest.version}.zip`;
  const zipFilePath = path.join(distDir, zipName);

  console.log(`🗜️ Zipping package to: ${zipFilePath}...`);
  
  // Use native macOS zip tool for zero-dependency zipping
  execSync(`zip -r "${zipFilePath}" .`, { cwd: tempDir, stdio: 'ignore' });

  console.log(`\n✨ [OpenGPEX Packager] Plugin compiled successfully!`);
  console.log(`📁 Output file: dist/${zipName}\n`);

} catch (err) {
  console.error('\n❌ [OpenGPEX Packager Error]: Bundling failed.', err);
  process.exit(1);
} finally {
  // Clean up temporary directory
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
