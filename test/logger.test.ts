import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Logger, silentLogger } from '../src/logger.js';
import { recordingLogger, tempDir } from './helpers.js';

describe('Logger', () => {
  it('writes text lines with fields and respects the level', () => {
    const lines: string[] = [];
    const logger = new Logger({ level: 'info', write: (line) => lines.push(line) });
    logger.debug('hidden');
    logger.info('Deployed', { commit: 'abc', count: 2, list: [1], error: new Error('boom'), skip: undefined });
    logger.warn('Careful');
    logger.error('Broken', { fn: () => 1 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\d{4}-\d\d-\d\dT.+ INFO {2}Deployed commit=abc count=2 list=\[1\] error=boom$/);
    expect(lines[1]).toContain('WARN  Careful');
    expect(lines[2]).toContain('fn=() => 1');
    expect(logger.enabled('debug')).toBe(false);
  });

  it('writes JSON records', () => {
    const { logger, records } = recordingLogger();
    logger.info('Hello', { error: new Error('bad'), n: 1 });
    expect(records[0]).toMatchObject({ level: 'info', message: 'Hello', fields: { error: 'bad', n: 1 } });
  });

  it('hides secrets, also inside longer ones, and keeps one record on one line', () => {
    const { logger, lines } = recordingLogger(['abcd', 'token-abcd-123', '']);
    logger.info('uses token-abcd-123 and abcd', { output: 'line1\nline2' });
    expect(lines[0]).not.toContain('abcd');
    expect(lines[0]).toContain('uses *** and ***');
    expect(lines[0]).not.toMatch(/\n/);
    expect(logger.redact('xx abc')).toBe('xx abc');
  });

  it('keeps short values that would hide too much', () => {
    const lines: string[] = [];
    new Logger({ secrets: ['ab', 'abcd'], write: (line) => lines.push(line) }).info('ab abcd');
    expect(lines[0]).toContain('ab ***');
  });

  it('appends to a file', () => {
    const file = path.join(tempDir(), 'logs', 'out.log');
    const logger = new Logger({ file, write: () => undefined, secrets: ['secret'] });
    logger.info('one secret');
    logger.warn('two', { multi: 'a\r\nb' });
    const content = readFileSync(file, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(2);
    expect(content).toContain('one ***');
    expect(content).toContain('multi=a | b');
  });

  it('sends warnings and errors to stderr by default', () => {
    const out = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const err = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const logger = new Logger();
    logger.info('to stdout');
    logger.error('to stderr');
    expect(out).toHaveBeenCalledWith(expect.stringContaining('to stdout'));
    expect(err).toHaveBeenCalledWith(expect.stringContaining('to stderr'));
    silentLogger.error('nothing');
    expect(err).toHaveBeenCalledTimes(1);
  });
});
