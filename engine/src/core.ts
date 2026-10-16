import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * The planning core: the existing browser modules in dist/, reused unchanged
 * (design section 3.2). They are UMD-style files that export with module.exports.
 */
const MODULES = ['engine', 'preflight', 'images', 'security', 'routing', 'pilot', 'storage', 'gitops', 'target-checks', 'acceptance', 'waves', 'execution', 'project', 'journey', 'changes', 'handoff'] as const;
export type CoreModuleName = (typeof MODULES)[number];

export interface Core {
  dir: string;
  modules: Record<CoreModuleName, unknown>;
}

export function loadCore(dir: string): Core {
  const require = createRequire(path.join(dir, 'package-loader.cjs'));
  const modules = {} as Record<CoreModuleName, unknown>;
  for (const name of MODULES) {
    const file = path.join(dir, name + '.js');
    if (!fs.existsSync(file)) throw new Error(`Planning core module missing: ${file}`);
    modules[name] = require(file);
  }
  return { dir, modules };
}
