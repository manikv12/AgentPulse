import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { codexStderrLinesForLog, resolveCodexBinary } from './app-server-client';

describe('Codex App Server stderr logging', () => {
  it('suppresses known noisy Codex warnings in normal logs', () => {
    const lines = codexStderrLinesForLog(
      [
        '{"level":"WARN","fields":{"message":"unknown feature key in config: voice_transcription"}}',
        '{"level":"WARN","fields":{"message":"skipping duplicate plugin MCP server name"}}',
        '{"level":"WARN","fields":{"message":"slow statement: execution time exceeded alert threshold"}}',
        '{"level":"WARN","fields":{"message":"acquired connection, but time to acquire exceeded slow threshold","aquired_after_secs":2.01}}',
        '{"level":"WARN","fields":{"message":"thread/resume overrides ignored for running thread abc"}}',
        '{"level":"WARN","fields":{"message":"overwriting handler for tool exec_command"}}',
        '{"level":"WARN","fields":{"message":"Failed to delete shell snapshot at \\"/tmp/missing.sh\\": No such file or directory"}}',
        '{"timestamp":"2026-04-27T19:46:30.177418Z","level":"WARN","fields":{"message":"dropping overload response for connection ConnectionId(0): outbound queue is full"},"target":"codex_app_server::transport"}',
        '{"level":"WARN","fields":{"message":"failed to connect to app-server remote control websocket: wss://chatgpt.com/backend-api/wham/remote/control/server, err: remote control server enrollment failed at `https://chatgpt.com/backend-api/wham/remote/control/server/enroll`: HTTP 404 Not Found"}}'
      ].join('\n')
    );

    expect(lines).toEqual([]);
  });

  it('keeps real stderr lines visible', () => {
    expect(
      codexStderrLinesForLog(
        [
          '{"level":"WARN","fields":{"message":"unknown feature key in config: voice_transcription"}}',
          'real app-server failure'
        ].join('\n')
      )
    ).toEqual(['real app-server failure']);
  });

  it('shows every stderr line when debug logging is enabled', () => {
    const noisyLine =
      '{"level":"WARN","fields":{"message":"thread/resume overrides ignored for running thread abc"}}';

    expect(codexStderrLinesForLog(noisyLine, { debug: true })).toEqual([noisyLine]);
  });

  it('keeps actionable auth failures visible', () => {
    const authFailure = 'failed request: 401 Unauthorized';

    expect(codexStderrLinesForLog(authFailure)).toEqual([authFailure]);
  });

  it('suppresses background ChatGPT auth retry noise', () => {
    const authRetryNoise = [
      '2026-04-27T20:24:35.767242Z ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: HTTP error: 403 Forbidden, url: wss://chatgpt.com/backend-api/codex/responses',
      '{"message":"failed to warm featured plugin ids cache","error":"remote plugin sync request to https://chatgpt.com/backend-api/plugins/featured failed with status 403 Forbidden"}',
      '{"message":"events failed with status 403 Forbidden: https://chatgpt.com/backend-api/codex/analytics-events/events"}'
    ].join('\n');

    expect(codexStderrLinesForLog(authRetryNoise)).toEqual([]);
  });
});

describe('resolveCodexBinary', () => {
  it('uses an explicit binary override first', () => {
    expect(
      resolveCodexBinary({
        codexBinary: 'C:\\Tools\\codex-custom.exe',
        platform: 'win32',
        exists: () => false
      })
    ).toBe('C:\\Tools\\codex-custom.exe');
  });

  it('keeps the bundled macOS Codex binary when it exists', () => {
    expect(
      resolveCodexBinary({
        platform: 'darwin',
        exists: (candidate) => candidate === '/Applications/Codex.app/Contents/Resources/codex',
        env: { PATH: '' }
      })
    ).toBe('/Applications/Codex.app/Contents/Resources/codex');
  });

  it('checks Windows cmd and exe candidates from PATH', () => {
    const toolDir = 'C:\\Tools';
    const npmDir = 'C:\\Users\\me\\AppData\\Roaming\\npm';

    expect(
      resolveCodexBinary({
        platform: 'win32',
        homeDir: 'C:\\Users\\me',
        env: { PATH: `${toolDir};${npmDir}` },
        exists: (candidate) => candidate === path.join(toolDir, 'codex.cmd')
      })
    ).toBe(path.join(toolDir, 'codex.cmd'));
  });

  it('falls back to codex.cmd on Windows', () => {
    expect(
      resolveCodexBinary({
        platform: 'win32',
        homeDir: 'C:\\Users\\me',
        env: { PATH: '' },
        exists: () => false
      })
    ).toBe('codex.cmd');
  });
});
