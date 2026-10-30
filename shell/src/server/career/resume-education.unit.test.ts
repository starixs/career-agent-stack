import type { ResumeMaster } from '@career/core';
import { describe, expect, it } from 'vitest';

import { educationFromMaster, educationRows, withResumeEducation } from './resume-education';

const master = (education: unknown): ResumeMaster => ({ id: 'rm_1', name: '主简历', direction: null, schema_json: JSON.stringify({ version: 1, education }), created_at: '', updated_at: '' });

describe('填表资料的教育经历按主简历补齐', () => {
  it('私密库只有毕业时间：按学校补上入学时间（简历写 2023.09 → 2023-09），已有的值不覆盖', () => {
    const fromResume = educationFromMaster(master([{ school: '华东理工大学', degree: '本科', major: '计算机科学与技术', start: '2023.09', end: '2027.06' }]));
    const merged = withResumeEducation([{ school: '华东理工大学', major: '计算机', degree: '本科', end: '2027-06' }], fromResume);
    expect(merged).toEqual([{ school: '华东理工大学', major: '计算机', degree: '本科', start: '2023-09', end: '2027-06' }]);
  });

  it('学校写的是占位符也能对上（各只有一段）；资料里没有教育经历就整段用简历的；读不出来不影响', () => {
    const fromResume = educationFromMaster(master([{ school: '{{vault:profile.school}}', start: '2023.09', end: '2027.06' }]));
    expect(withResumeEducation([{ school: '华东理工大学' }], fromResume)[0]).toMatchObject({ school: '华东理工大学', start: '2023-09' });
    expect(withResumeEducation([], educationFromMaster(master([{ school: '复旦大学', start: '2021/09' }])))).toEqual([{ school: '复旦大学', major: undefined, degree: undefined, start: '2021-09', end: undefined }]);
    expect(educationFromMaster({ ...master([]), schema_json: '{坏的' })).toEqual([]);
    expect(educationRows('不是数组')).toEqual([]);
  });
});
