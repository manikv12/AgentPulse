import { describe, expect, it } from 'vitest';
import { codexStderrLinesForLog } from './app-server-client';

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

  it('does not hide auth failures', () => {
    const authFailure = 'failed request: 401 Unauthorized';

    expect(codexStderrLinesForLog(authFailure)).toEqual([authFailure]);
  });
});
