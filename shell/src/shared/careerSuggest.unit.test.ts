import { describe, expect, it } from 'vitest';

import { FEATURE_IDS, FEATURES, featureChipText, featuresInGroup, resolveFeatureStart } from './careerFeatures';
import { CAREER_SUGGEST_EVENT, parseSuggest, parseSuggestAction, parseSuggestPush, parseSuggestScene } from './careerSuggest';

describe('careerSuggest contracts (r3)', () => {
  it('keeps a legal start_feature action with args', () => {
    expect(parseSuggestAction({ type: 'start_feature', feature_id: 'exam_search' })).toEqual({ type: 'start_feature', feature_id: 'exam_search' });
    expect(parseSuggestAction({ type: 'start_feature', feature_id: 'interview_predict', args: { company: '字节', x: 1 } }))
      .toEqual({ type: 'start_feature', feature_id: 'interview_predict', args: { company: '字节' } });
  });

  it('drops an unknown feature id and degrades the chip to say', () => {
    expect(parseSuggestAction({ type: 'start_feature', feature_id: 'fly_to_mars' })).toBeNull();
    const [chip] = parseSuggest({ chips: [{ text: '去火星', slot: 'shape', kind: 'do', mode: 'start', action: { type: 'start_feature', feature_id: 'mars' }, seed_id: null }] });
    expect(chip).toEqual({ text: '去火星', slot: 'shape', kind: 'say', mode: 'start', seed_id: null });
  });

  it('keeps ask_choose only with both ask_id and choice', () => {
    expect(parseSuggestAction({ type: 'ask_choose', ask_id: 'a1', choice: '接受调剂', x: 1 })).toEqual({ type: 'ask_choose', ask_id: 'a1', choice: '接受调剂' });
    expect(parseSuggestAction({ type: 'ask_choose', ask_id: 'a1' })).toBeNull();
    expect(parseSuggestAction({ type: 'ask_choose', ask_id: '', choice: '是' })).toBeNull();
  });

  it('fills mode from slot when old data has none', () => {
    const [chip] = parseSuggest({ chips: [{ text: '我先去忙', slot: 'exit', kind: 'say', seed_id: null }] });
    expect(chip.mode).toBe('exit');
    expect(parseSuggestScene({ chips: [], scene: 'S13' })).toBe('S13');
    expect(parseSuggestScene({ chips: [] })).toBeNull();
  });

  it('parseSuggestPush keeps a legal career:suggest payload', () => {
    const chip = { text: '就这 5 家', slot: 'next', kind: 'do', mode: 'advance', action: { type: 'open_deck' }, seed_id: null };
    expect(CAREER_SUGGEST_EVENT).toBe('career:suggest');
    expect(parseSuggestPush({ sessionId: 's1', turn_id: 't1', assistant_message_id: 'm1', chips: [chip], scene: 'S14', source: 'hook', degraded: false, ts: 42 }))
      .toEqual({ sessionId: 's1', turn_id: 't1', assistant_message_id: 'm1', chips: [chip], scene: 'S14', source: 'hook', degraded: false, ts: 42 });
  });

  it('parseSuggestPush drops bad chips and nulls missing ids', () => {
    const push = parseSuggestPush({ sessionId: 's1', scene: 'S3', degraded: true, chips: [{ text: '' , slot: 'act' }, { text: '对，就是这个', slot: 'act', kind: 'say', seed_id: null }, 'x'] });
    expect(push?.chips).toEqual([{ text: '对，就是这个', slot: 'act', kind: 'say', mode: 'answer', seed_id: null }]);
    expect(push?.turn_id).toBeNull();
    expect(push?.assistant_message_id).toBeNull();
    expect(push?.degraded).toBe(true);
  });

  it('parseSuggestPush returns null without sessionId or scene', () => {
    expect(parseSuggestPush({ scene: 'S1', chips: [] })).toBeNull();
    expect(parseSuggestPush({ sessionId: 's1', chips: [] })).toBeNull();
    expect(parseSuggestPush(null)).toBeNull();
  });

  it('features: every id defined, chips fit, company token resolved', () => {
    for (const id of FEATURE_IDS) {
      expect(FEATURES[id].id).toBe(id);
      expect(featureChipText(id).length).toBeLessThanOrEqual(22);
      expect(featureChipText(id)).not.toContain('{company}');
    }
    expect(featureChipText('interview_prep', '字节')).toBe('帮我准备字节这场面试');
    expect(resolveFeatureStart('interview_predict', { company: '字节' })).toEqual({ prefill: '预测一下字节会深挖我简历哪里' });
    expect(resolveFeatureStart('interview_predict')).toEqual({ prefill: '预测一下这家公司会深挖我简历哪里：' });
    expect(resolveFeatureStart('open_q', { company: '' })).toEqual({ prefill: '帮我写「为什么选择我们」，300 字，给这家公司：' });
    expect(resolveFeatureStart('interview_retro')).toEqual({ prefill: '帮我复盘刚才的面试：' });
    expect(resolveFeatureStart('interview_retro', { company: '美团' })).toEqual({ prefill: '帮我复盘刚才美团的面试：' });
    for (const id of FEATURE_IDS) {
      const start = resolveFeatureStart(id);
      if ('prefill' in start) expect(start.prefill).not.toContain('{company}');
    }
    expect(featuresInGroup('workbench')).toHaveLength(6);
    expect(featuresInGroup('chat')).toHaveLength(9);
  });
});
