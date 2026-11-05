/**
 * 存过的附件（第三轮 R1）：校验扩展名 / 大小 / 文件名，同一内容只存一份。
 */
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Repos } from '@career/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIL_FILE_MAX_BYTES } from '../../../shared/careerMailApply';
import { createMemoryRepos } from '../test-db';
import { cleanFilename, getMailFile, listMailFiles, MAIL_FILES_KEY, MailFileError, saveMailFile } from './files';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

describe('存过的附件', () => {
  let dir: string;
  let repos: Repos;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'career-mail-files-')); repos = createMemoryRepos(); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('存一个：落盘按内容哈希命名，清单里有名字、大小；名字不给就用文件名去掉扩展名', () => {
    const f = saveMailFile(repos, dir, { name: '我的作品集.PDF', base64: b64('%PDF 1') });
    expect(f).toMatchObject({ label: '我的作品集', filename: '我的作品集.PDF', size: 6 });
    expect(f.path).toBe(join(dir, `${f.sha256}.pdf`));
    expect(existsSync(f.path)).toBe(true);
    expect(listMailFiles(repos)).toEqual([f]);
    expect(getMailFile(repos, f.id)).toEqual(f);
  });

  it('同一内容再存一次不重复', () => {
    const a = saveMailFile(repos, dir, { name: 'a.pdf', base64: b64('%PDF same'), label: '作品集' });
    const b = saveMailFile(repos, dir, { name: 'b.pdf', base64: b64('%PDF same'), label: '别的名字' });
    expect(b.id).toBe(a.id);
    expect(listMailFiles(repos)).toHaveLength(1);
  });

  it('不合格的说人话：文件类型、空文件、超过 10MB', () => {
    expect(() => saveMailFile(repos, dir, { name: 'run.exe', base64: b64('x') })).toThrow(new MailFileError('这种文件发不了，换成 PDF、Word、PPT、图片或压缩包'));
    expect(() => saveMailFile(repos, dir, { name: '没有扩展名', base64: b64('x') })).toThrow(MailFileError);
    expect(() => saveMailFile(repos, dir, { name: 'a.pdf', base64: '' })).toThrow('这个文件是空的');
    expect(() => saveMailFile(repos, dir, { name: 'big.pdf', base64: Buffer.alloc(MAIL_FILE_MAX_BYTES + 1).toString('base64') })).toThrow('文件超过 10MB，换成链接更合适');
    expect(listMailFiles(repos)).toEqual([]);
  });

  it('文件名去掉路径与文件系统不认的字符；清单里坏的条目丢掉不挡别的', () => {
    expect(cleanFilename('../../etc/作品*集?.pdf')).toBe('作品集.pdf');
    expect(cleanFilename('C:\\Users\\me\\成绩单.pdf')).toBe('成绩单.pdf');
    const ok = saveMailFile(repos, dir, { name: '成绩单.pdf', base64: b64('%PDF t') });
    repos.kvSet(MAIL_FILES_KEY, [...listMailFiles(repos), { id: 'broken' }]);
    expect(listMailFiles(repos)).toEqual([ok]);
  });
});
