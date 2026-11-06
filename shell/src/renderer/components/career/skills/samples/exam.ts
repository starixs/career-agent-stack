/**
 * 笔试助力的示例：这一场还没有粘进任何题时，右栏摆一道示例题和它的答案，让他一眼看到贴进题后这页长什么样。
 * 题是自己编的常见数字推理题，不出自任何公司的真题；只在页面上渲染，不进这场的步骤、不写库、不发给模型。
 */
import type { QuestionAnswer, SearchQuestion } from '../../exam-search/examSearchApi';

export const SAMPLE_EXAM_QUESTIONS: readonly SearchQuestion[] = [
  { index: 0, stem: '找规律填数：2，6，12，20，30，（　）', options: ['A. 42', 'B. 40', 'C. 44', 'D. 36'], qtype: 'single', matches: [] },
];

export const SAMPLE_EXAM_ANSWERS: readonly QuestionAnswer[] = [
  {
    index: 0, answer: 'A', explanation: '相邻两项之差依次是 4、6、8、10，下一个差 12，30 + 12 = 42。',
    confidence: 'high', source: 'model', ref_item_id: null,
  },
];
