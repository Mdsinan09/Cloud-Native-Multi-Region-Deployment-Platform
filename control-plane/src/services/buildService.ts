/**
 * Build Service
 * Handles Docker build and push operations
 */
import { spawn } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const execAsync = promisify(require('child_process').exec);

export interface BuildOptions {
  repoUrl: string;
  commitSha: string;
  appName: string;
  registryUsername: string;
  buildDir: string;
}

export interface BuildResult {
  success: boolean;
  imageTag: string;
  logs: string[];
  error?: string;
}

/**
 * Clone a git repository at a specific commit
 */
export async function cloneRepo(
  repoUrl: string,
  commitSha: string,
  buildDir: string,
  onLog?: (log: string) => void
): Promise<void> {
  // Ensure build directory exists
  await fs.promises.mkdir(buildDir, { recursive: true });

  // Clean previous build
  await fs.promises.rm(buildDir, { recursive: true, force: true });
  await fs.promises.mkdir(buildDir, { recursive: true });

  return new Promise((resolve, reject) => {
    const cloneCmd = spawn('git', [
      'clone',
      '--depth', '1',
      repoUrl,
      buildDir,
    ]);

    let output = '';

    cloneCmd.stdout.on('data', (data) => {
      const line = data.toString();
      output += line;
      onLog?.(`[CLONE] ${line.trim()}`);
    });

    cloneCmd.stderr.on('data', (data) => {
      const line = data.toString();
      output += line;
      onLog?.(`[CLONE] ${line.trim()}`);
    });

    cloneCmd.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(`Git clone failed with code ${code}: ${output}`));
        return;
      }

      // Checkout specific commit
      try {
        const checkout = spawn('git', ['checkout', commitSha], { cwd: buildDir });
        let checkoutOutput = '';

        checkout.stdout.on('data', (data) => {
          checkoutOutput += data.toString();
        });
        checkout.stderr.on('data', (data) => {
          checkoutOutput += data.toString();
        });

        checkout.on('close', (checkoutCode) => {
          if (checkoutCode !== 0) {
            // For shallow clone, the commit might already be at HEAD
            onLog?.(`[CLONE] Checkout returned ${checkoutCode}, continuing with HEAD`);
          }
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  });
}

/**
 * Build a Docker image
 */
export async function buildImage(
  buildDir: string,
  imageTag: string,
  onLog?: (log: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const build = spawn('docker', ['build', '-t', imageTag, '.'], {
      cwd: buildDir,
    });

    let output = '';

    build.stdout.on('data', (data) => {
      const line = data.toString();
      output += line;
      onLog?.(`[BUILD] ${line.trim()}`);
    });

    build.stderr.on('data', (data) => {
      const line = data.toString();
      output += line;
      onLog?.(`[BUILD] ${line.trim()}`);
    });

    build.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Docker build failed with code ${code}: ${output}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Push a Docker image to registry
 */
export async function pushImage(
  imageTag: string,
  onLog?: (log: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const push = spawn('docker', ['push', imageTag]);

    let output = '';

    push.stdout.on('data', (data) => {
      const line = data.toString();
      output += line;
      onLog?.(`[PUSH] ${line.trim()}`);
    });

    push.stderr.on('data', (data) => {
      const line = data.toString();
      output += line;
      onLog?.(`[PUSH] ${line.trim()}`);
    });

    push.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Docker push failed with code ${code}: ${output}`));
        return;
      }
      resolve();
    });
  });
}

/**
 * Full build pipeline: clone → build → push
 */
export async function runBuild(
  options: BuildOptions,
  onLog?: (log: string) => void
): Promise<BuildResult> {
  const { repoUrl, commitSha, appName, registryUsername, buildDir } = options;
  const imageTag = `${registryUsername}/${appName}:${commitSha}`;
  const logs: string[] = [];

  const log = (msg: string) => {
    logs.push(msg);
    onLog?.(msg);
  };

  try {
    log(`🚀 Starting build for ${appName}:${commitSha}`);

    // Clone
    log('📦 Cloning repository...');
    await cloneRepo(repoUrl, commitSha, buildDir, log);
    log('✅ Repository cloned');

    // Build
    log('🔨 Building Docker image...');
    await buildImage(buildDir, imageTag, log);
    log('✅ Image built');

    // Push
    log('📤 Pushing to registry...');
    await pushImage(imageTag, log);
    log('✅ Image pushed');

    return {
      success: true,
      imageTag,
      logs,
    };
  } catch (err: any) {
    log(`❌ Build failed: ${err.message}`);
    return {
      success: false,
      imageTag,
      logs,
      error: err.message,
    };
  }
}

/**
 * Clean up build directory
 */
export async function cleanupBuildDir(buildDir: string): Promise<void> {
  try {
    await fs.promises.rm(buildDir, { recursive: true, force: true });
  } catch (err) {
    console.warn('⚠️ Failed to clean up build directory:', err);
  }
}
