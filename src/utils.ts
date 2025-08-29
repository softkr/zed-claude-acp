/**
 * Package Manager Detection Utilities
 * 
 * Provides utilities to detect and work with both npm and yarn package managers
 */

import { existsSync } from 'fs';
import { join } from 'path';

export type PackageManager = 'yarn' | 'npm';

/**
 * Detects the preferred package manager for the current project
 * Priority: yarn.lock > package-lock.json > yarn (fallback)
 */
export function detectPackageManager(projectRoot: string = process.cwd()): PackageManager {
  // Check for yarn.lock first (yarn preferred)
  if (existsSync(join(projectRoot, 'yarn.lock'))) {
    return 'yarn';
  }
  
  // Check for package-lock.json (npm)
  if (existsSync(join(projectRoot, 'package-lock.json'))) {
    return 'npm';
  }
  
  // Check for .yarnrc.yml or .yarnrc (yarn configuration)
  if (existsSync(join(projectRoot, '.yarnrc.yml')) || existsSync(join(projectRoot, '.yarnrc'))) {
    return 'yarn';
  }
  
  // Default to yarn if no lock files found
  return 'yarn';
}

/**
 * Gets the appropriate command for running package manager executables
 */
export function getPackageManagerCommand(pm: PackageManager): string {
  switch (pm) {
    case 'yarn':
      return 'yarn';
    case 'npm':
      return 'npx';
    default:
      return 'yarn';
  }
}

/**
 * Gets the appropriate arguments for running the package with dlx/npx
 */
export function getPackageManagerArgs(pm: PackageManager, packageName: string): string[] {
  switch (pm) {
    case 'yarn':
      return ['dlx', packageName];
    case 'npm':
      return ['--yes', packageName];
    default:
      return ['dlx', packageName];
  }
}

/**
 * Gets install command for the package manager
 */
export function getInstallCommand(pm: PackageManager): string[] {
  switch (pm) {
    case 'yarn':
      return ['yarn', 'install'];
    case 'npm':
      return ['npm', 'install'];
    default:
      return ['yarn', 'install'];
  }
}

/**
 * Gets build command for the package manager
 */
export function getBuildCommand(pm: PackageManager): string[] {
  switch (pm) {
    case 'yarn':
      return ['yarn', 'build'];
    case 'npm':
      return ['npm', 'run', 'build'];
    default:
      return ['yarn', 'build'];
  }
}