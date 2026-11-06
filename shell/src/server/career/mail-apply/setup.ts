/**
 * 邮件投递工作台上只设一次的发信设置（合同 MailSetupView / MailSetupPatch；POST /api/career/mail-apply/setup）：
 * 发件邮箱、到岗信息、常用附件、作品集链接、写好直接发。
 * 「写好直接发」= 给信任账本里「邮件投递」这一类盖章 / 收回（只有他点这个开关才会变，AI 不自己升）；
 * 自动投递总开关开着时显示为 auto（总开关不在这里改）。
 */
import type { Repos, Vault } from '@career/core';

import { MAIL_TRUST_KEY, MAIL_TRUST_LABEL, type MailSetupPatch, type MailSetupView } from '../../../shared/careerMailApply';
import type { CareerStore } from '../store';
import { getAutoMode } from '../submit-policy';
import { delegate, readLedger, revoke, TRUST_LEDGER_KEY, trustOf } from '../trust-ledger';
import { MailAttachmentError } from './attachments-edit';
import { isWebUrl, readMailProfile } from './compose';
import { fileOption, listMailFiles } from './files';

export interface MailSetupDeps { repos: Repos; vault: Vault | null; store: CareerStore }

export function directSendOf(repos: Repos): MailSetupView['direct_send'] {
  if (getAutoMode(repos).enabled) return 'auto';
  return trustOf(repos, MAIL_TRUST_KEY) === 'delegated' ? 'delegated' : 'off';
}

export function mailSetupView(deps: MailSetupDeps): MailSetupView {
  const account = deps.repos.listMailAccounts()[0];
  const { profile, availability } = readMailProfile(deps.vault);
  return {
    mailbox: account ? { account_id: account.id, address: account.address } : null,
    availability,
    files: listMailFiles(deps.repos).map(fileOption),
    portfolio_url: profile.portfolio ?? null,
    direct_send: directSendOf(deps.repos),
    // 有没有至少一份简历（主简历或定制版）：没有时前端把「写这 N 封」换成「先放一份简历」
    has_resume: deps.store.listResumeMasters().length > 0 || deps.store.listResumeTailored().length > 0,
  };
}

/** 盖章：账本里还没有这一类（一封都没发过）就先建一条（shown、0 次），再盖。 */
function stampMailClass(repos: Repos): void {
  if (!readLedger(repos)[MAIL_TRUST_KEY]) {
    repos.kvSet(TRUST_LEDGER_KEY, { ...readLedger(repos), [MAIL_TRUST_KEY]: { key: MAIL_TRUST_KEY, kind: 'system', label: MAIL_TRUST_LABEL, state: 'shown', successes: 0, updated_at: new Date().toISOString() } });
  }
  delegate(repos, MAIL_TRUST_KEY);
}

/** 改发信设置；不合格抛 MailAttachmentError（给人看的一句）。 */
export function saveMailSetup(deps: MailSetupDeps, patch: MailSetupPatch): MailSetupView {
  if (patch.portfolio_url !== undefined) {
    const url = patch.portfolio_url.trim();
    if (!isWebUrl(url)) throw new MailAttachmentError('这不像一个网址');
    if (!deps.vault) throw new MailAttachmentError('私密库没打开，链接存不了');
    deps.vault.set({ scope: 'profile', field: 'portfolio', value: url, sensitive: false });
  }
  if (patch.direct_send === true) stampMailClass(deps.repos);
  if (patch.direct_send === false) revoke(deps.repos, MAIL_TRUST_KEY);
  console.log(`[career] mail-apply setup saved fields=${Object.keys(patch).join(',')} direct_send=${directSendOf(deps.repos)}`);
  return mailSetupView(deps);
}
