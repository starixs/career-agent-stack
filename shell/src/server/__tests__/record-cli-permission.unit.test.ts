import { describe, expect, it } from 'vitest';

import { isAutoAllowedRecordCliCommand } from '../agent-session';

describe('Record CLI automatic permission', () => {
  it.each([
    'keystone record list',
    'keystone record list --kind text --tag meeting-1 --limit 25 --json',
    'keystone record list --json --kind audio',
    'keystone thought list --tag legacy --limit 10 --json',
    "keystone record create 'remember $(literal) and `literal`'",
    "keystone record create --content 'multi word literal'",
    'keystone record create --content-file /tmp/record.txt',
    "keystone thought create 'legacy literal'",
    'keystone thought create --content-file C:\\Temp\\record.txt',
  ])('allows the bounded literal form: %s', command => {
    expect(isAutoAllowedRecordCliCommand(command)).toBe(true);
  });

  it.each([
    "keystone record list --query '$(touch /tmp/pwn)'",
    'keystone record list --kind video',
    'keystone thought list --kind audio',
    'keystone record create "$(touch /tmp/pwn)"',
    'keystone record create --content "$(touch /tmp/pwn)"',
    "keystone record create 'safe' extra",
    "keystone record create 'safe'; touch /tmp/pwn",
    "keystone record create 'safe' && touch /tmp/pwn",
    'keystone record create --content-file /tmp/record.txt;touch',
    "keystone record create --content-file '/tmp/record.txt'",
    "keystone record list\nrm -rf /tmp/pwn",
  ])('requires normal permission handling for: %s', command => {
    expect(isAutoAllowedRecordCliCommand(command)).toBe(false);
  });
});
