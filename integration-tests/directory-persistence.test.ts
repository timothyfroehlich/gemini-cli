/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestRig } from './test-helper.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('directory-persistence', () => {
  let rig: TestRig;

  beforeEach(() => {
    rig = new TestRig();
  });

  afterEach(async () => await rig.cleanup());

  it('should persist directories added via /dir add across resumed sessions', async () => {
    // 1. Setup
    rig.setup(
      'should persist directories added via /dir add across resumed sessions',
      {
        settings: {
          security: { auth: { selectedType: 'gemini-api-key' } },
        },
      },
    );

    // Create a directory to add
    const dirPath = 'extra-dir';
    rig.mkdir(dirPath);

    // 2. Add directory in first session
    // We use a prompt that will finish quickly
    await rig.run({
      args: [
        '--prompt',
        `/dir add ${dirPath}
exit`,
      ],
    });

    // 3. Extract session ID from telemetry
    await rig.waitForTelemetryReady();
    const logFilePath = join(rig.homeDir!, 'telemetry.log');
    const logContent = readFileSync(logFilePath, 'utf-8');

    // Find a session_start or any event to get the sessionId
    // Session ID is usually in the attributes or part of the log entry
    const sessionIdMatch = logContent.match(/"sessionId":"([^"]+)"/);
    if (!sessionIdMatch) {
      throw new Error('Could not find sessionId in telemetry logs');
    }
    const sessionId = sessionIdMatch[1];

    // 4. Resume session and check if directory is still there
    const result = await rig.run({
      args: ['--resume', sessionId, '--prompt', '/dir show'],
    });

    // The output of /dir show should contain our directory
    // Note: getDirectories returns real paths (resolved)
    expect(result).toContain(dirPath);
  });
});
