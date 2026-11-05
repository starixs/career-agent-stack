/**
 * 多附件与作品集链接（第三轮 R1）：预览里加 / 拿掉附件、总大小上限、作品集那一行的加删（他手改过的不动）、
 * 起草时按岗位描述给的默认，以及预览里的 wanted / file_options。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MAIL_FILE_MAX_BYTES } from '../../../shared/careerMailApply';
import { ARRIVAL_TAIL } from './compose';
import { mailDefaults } from './defaults';
import { MailDraftError, patchMailDraft } from './edit';
import { saveMailFile } from './files';
import { attachmentsOf, parseSendMailPayload } from './payload';
import { mailFixture, type MailFixture } from './test-fixture';
import { mailDraftView } from './view';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');
const INTRO = '您好！我是华东大学计算机科学专业学生，应聘产品实习生。';
const BODY = `${INTRO}\n\n${ARRIVAL_TAIL}\n\n{{vault:profile.name}}`;
const URL1 = 'https://me.example.com/works';

describe('多附件与作品集链接', () => {
  let dir: string;
  let f: MailFixture;
  let resumePath: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'career-mail-att-'));
    f = await mailFixture(dir);
    resumePath = join(dir, 'resume.pdf');
    writeFileSync(resumePath, '%PDF resume');
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** 一封待发的投递邮件；岗位描述写了要作品集和成绩单。 */
  function pending(jd = '产品实习生\n岗位职责：竞品分析。\n请附上作品集与成绩单，简历投递至 hr@jia.com') {
    const job = f.repos.upsertJob({ source_platform: 'manual', source_job_id: jd.length.toString(), title: '产品实习生', company_name: '甲科技', jd_raw: jd });
    const app = f.repos.createApplication(job.id);
    return f.repos.enqueueAction('send_mail', { account_id: '', to: 'hr@jia.com', subject: '应聘', body: BODY, purpose: 'apply', arrival_line: ARRIVAL_TAIL, application_id: app.id, job_id: job.id, attachments: [{ path: resumePath, filename: '简历.pdf' }] }, app.id);
  }
  const patch = (id: string, p: Parameters<typeof patchMailDraft>[2]) => patchMailDraft(f.deps, id, p);
  const stored = (id: string) => parseSendMailPayload(id, f.repos.getAction(id)!.payload_json);

  it('老数据没有 id / kind 的附件按简历读', () => {
    expect(attachmentsOf({ attachments: [{ path: 'a.pdf' }, { path: 'b.pdf' }] }).map(a => [a.id, a.kind])).toEqual([['resume', 'resume'], ['att1', 'resume']]);
  });

  it('附上一个存过的文件、拿掉它、简历也能拿掉；可选里只列还没附上的', async () => {
    const a = pending();
    const file = saveMailFile(f.repos, dir, { name: '作品集.pdf', base64: b64('%PDF works'), label: '作品集' });
    let v = mailDraftView(f.deps, f.repos.getAction(a.id)!);
    expect(v.file_options).toEqual([{ id: file.id, label: '作品集' }]);
    v = await patch(a.id, { add_file_id: file.id });
    expect(v.attachments.map(x => [x.id, x.kind, x.filename, x.resume_label])).toEqual([['resume', 'resume', '简历.pdf', '简历'], [`file:${file.id}`, 'file', '作品集.pdf', '作品集']]);
    expect(v.file_options).toEqual([]);
    v = await patch(a.id, { remove_attachment_id: `file:${file.id}` });
    expect(v.attachments.map(x => x.kind)).toEqual(['resume']);
    v = await patch(a.id, { remove_attachment_id: 'resume' });
    expect(v.attachments).toEqual([]);
  });

  it('附件加起来超过 20MB：拒绝并说人话', async () => {
    const a = pending();
    writeFileSync(resumePath, Buffer.alloc(MAIL_FILE_MAX_BYTES + 1));
    const big = saveMailFile(f.repos, dir, { name: '作品集.pdf', base64: Buffer.alloc(MAIL_FILE_MAX_BYTES).toString('base64') });
    await expect(patch(a.id, { add_file_id: big.id })).rejects.toThrow(new MailDraftError('附件加起来超过 20MB 了，换成链接更合适'));
    expect(stored(a.id).attachments).toHaveLength(1);
  });

  it('作品集那一行：填链接存进资料并带上（到岗那句之前、单独一段）；去掉不留空行；他手改过的那行不动', async () => {
    const a = pending();
    await expect(patch(a.id, { portfolio_url: 'me.example.com' })).rejects.toThrow('这不像一个网址');
    let v = await patch(a.id, { portfolio_url: URL1 });
    expect(v.body.startsWith(`${INTRO}\n\n作品集：${URL1}\n\n${ARRIVAL_TAIL}`)).toBe(true);
    expect(v.portfolio).toEqual({ url: URL1, included: true });
    expect(v.wanted).toEqual(['transcript']);
    v = await patch(a.id, { include_portfolio: false });
    expect(stored(a.id).body).toBe(BODY);
    expect(v.portfolio).toEqual({ url: URL1, included: false });
    expect(v.wanted).toEqual(['portfolio', 'transcript']);
    // 他把那一行改成自己的说法：再点「不带」也不动他写的
    v = await patch(a.id, { include_portfolio: true });
    v = await patch(a.id, { body: v.body.replace(`作品集：${URL1}`, `作品集（密码 1234）：${URL1}`) });
    v = await patch(a.id, { include_portfolio: false });
    expect(v.body).toContain(`作品集（密码 1234）：${URL1}`);
  });

  it('起草默认：岗位描述要作品集——有链接带那一行、有作品集文件附上；什么都没有就进 wanted', async () => {
    const works = saveMailFile(f.repos, dir, { name: 'portfolio.pdf', base64: b64('%PDF w') });
    const grades = saveMailFile(f.repos, dir, { name: '成绩单.pdf', base64: b64('%PDF g') });
    const jd = '请附作品集';
    expect(mailDefaults({ jd, portfolioUrl: URL1, files: [], usedBytes: 0 })).toEqual({ portfolioLine: `作品集：${URL1}`, files: [] });
    expect(mailDefaults({ jd, portfolioUrl: undefined, files: [works, grades], usedBytes: 0 })).toEqual({ files: [works] });
    expect(mailDefaults({ jd: '只要简历', portfolioUrl: URL1, files: [works, grades], usedBytes: 0 })).toEqual({ files: [] });
    expect(mailDefaults({ jd, portfolioUrl: undefined, files: [works], usedBytes: 20 * 1024 * 1024 })).toEqual({ files: [] });
    const a = pending('请附作品集，简历投递至 hr@jia.com');
    expect(mailDraftView(f.deps, f.repos.getAction(a.id)!).wanted).toEqual(['portfolio']);
  });
});
