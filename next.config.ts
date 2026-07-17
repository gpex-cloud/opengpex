/**
 * =============================================================
 * NEXT.JS ARCHITECTURE CONFIGURATION (OPEN-SOURCE CORE)
 * =============================================================
 * * 【WASM Architecture Note - Next.js 16 Pure Rust Turbopack Edition】
 * Complex image processing WASM binaries are fully executed on 
 * the client-side via Web Workers inside the user's browser.
 * * Benefits of this Client-Centric Architecture:
 * 1. Bypasses aggressive bundle interventions and compilation errors.
 * 2. Eliminates the need for tedious server-side path mappings.
 * 3. Treats all `.wasm` files simply as static assets.
 * =============================================================
 * * 【Turbopack NFT (Node File Tracing) Rules】
 * During a Turbopack build, all filesystem operations in Server-side routes
 * (fs.readFile, path.join, path.resolve, etc.) are statically analysed.
 * Turbopack automatically traces files that may be accessed and bundles them
 * into the deployment artifact. If the traced scope is too broad (e.g. the
 * entire project root), it produces "Encountered unexpected file in NFT list"
 * warnings.
 *
 * 【Core Rule】When using path.join(process.cwd(), ...) in an API Route:
 *   ✅ Correct: use literal path segments so Turbopack can statically scope tracing
 *      path.join(process.cwd(), 'data', 'plugins', 'user')
 *   ❌ Wrong: use imported variables or concatenated strings — Turbopack cannot
 *      statically infer the scope
 *      path.join(process.cwd(), SOME_IMPORTED_VARIABLE)
 *      path.join(process.cwd(), 'data/plugins/' + folder)
 *
 * 【Fallback】If a literal path is not feasible, add an ignore comment before process.cwd():
 *      path.join(/​*turbopackIgnore: true*​/ process.cwd(), dynamicVar)
 *   Note: turbopackIgnore only suppresses tracing for path.join/resolve itself;
 *   it may not fully suppress tracing for subsequent fs.readFile(dynamicPath) calls.
 *   The most reliable approach is still to ensure the first path segment is a
 *   static literal string.
 * =============================================================
 */

import type { NextConfig } from "next";
import fs from "fs";
import path from "path";

// Read package.json version and inject as CORE_VERSION to client (determined at build time, auto-synced on release)
const pkg = JSON.parse(fs.readFileSync(path.resolve(/*turbopackIgnore: true*/ process.cwd(), "package.json"), "utf-8"));

// 🛡️ [OpenGPEX Config] Ensure registry-user.ts exists to prevent compilation failure if missing
const userRegistryPath = path.resolve(/*turbopackIgnore: true*/ process.cwd(), "src/lib/opengpex/plugins/registry-user.ts");
if (!fs.existsSync(userRegistryPath)) {
  console.log("[OpenGPEX Config] registry-user.ts is missing. Creating fallback empty registry...");
  fs.mkdirSync(path.dirname(userRegistryPath), { recursive: true });
  fs.writeFileSync(
    userRegistryPath,
    `/**
      * [Auto-generated Fallback]
      * Missing registry-user.ts detected and auto-created at startup.
      */
      export const PLUGINS = [];
      export default PLUGINS;
    `,
    "utf-8"
  );
}

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Cross-Origin Isolation headers: enable SharedArrayBuffer for WASM multi-threading
  // Required by wasm-vips (pthreads) and benefits other heavy WASM workloads.
  // require-corp mode enables cross-origin isolation.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },

  // Prevent Next.js/Turbopack from trying to bundle unzipper and its dynamic requires.
  // @huggingface/transformers + onnxruntime-web are client-only (Web Worker inference)
  // and must not be resolved/bundled server-side.
  serverExternalPackages: ["unzipper", "@huggingface/transformers", "onnxruntime-web"],

  // Inject CORE_VERSION at build time, accessible via process.env.NEXT_PUBLIC_CORE_VERSION on client
  // Value comes from package.json.version, auto-synced on npm version patch/minor releases
  env: {
    NEXT_PUBLIC_CORE_VERSION: pkg.version,
  },

  // Enable seamless compilation and Hot Module Replacement (HMR) 
  // for local monorepo packages or external TypeScript dependencies managed by pnpm.
  transpilePackages: ["@opengpex/core", "@opengpex/ui"],

  // CORRECT SPECIFICATION: Per official documentation, serverActions options 
  // (like bodySizeLimit) must remain inside the 'experimental' block.
  experimental: {
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },

  images: {
    // Disable Next.js server-side dynamic image optimization to ensure
    // zero server-side weight and maximum ecosystem compatibility.
    unoptimized: true,
    remotePatterns: [],
  },

  // NEXT.JS 16 RUST TURBOPACK NATIVE CONFIGURATION
  // We align exactly with Next.js 16 official specifications for handling static binary assets.
  turbopack: {
    rules: {
      // "*.wasm": ["raw-loader"],
    },
    // Map 'a' to an empty string to bypass incomplete Emscripten resolve paths.
    resolveAlias: {
      "a": "",
    }
  }
};

export default nextConfig;