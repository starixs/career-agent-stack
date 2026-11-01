/**
 * 开场"两扇门"里的「有，选个文件给我」（主线体验 §1）：打开文件选择，选中的简历一落进输入框就替他发出去，
 * 不再让他自己按发送。只认事件之后这一次选文件；取消选择或超时就作废，不会误发他后来手动引用的文件。
 */
import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';

import { onEvent } from '@/api/eventBus';

export const PICK_RESUME_EVENT = 'career:pick-resume';
export const RESUME_NOTE = '这是我的简历';
/** 浏览器环境下选文件的结果经 onChange 异步到达，最多等这么久。 */
const PICK_WINDOW_MS = 60_000;

export function useResumePickSend({ inputValue, setInputValue, pickFiles, send }: {
  inputValue: string;
  setInputValue: Dispatch<SetStateAction<string>>;
  pickFiles: () => Promise<number>;
  send: () => void;
}): void {
  const pickDeadlineRef = useRef(0);
  const sendPendingRef = useRef(false);

  useEffect(() => onEvent(PICK_RESUME_EVENT, () => {
    pickDeadlineRef.current = Date.now() + PICK_WINDOW_MS;
    void pickFiles().then(count => { if (count === 0) pickDeadlineRef.current = 0; });
  }), [pickFiles]);

  useEffect(() => {
    if (sendPendingRef.current && inputValue.includes(RESUME_NOTE)) {
      sendPendingRef.current = false;
      send();
      return;
    }
    if (Date.now() > pickDeadlineRef.current || !inputValue.includes('@')) return;
    pickDeadlineRef.current = 0;
    sendPendingRef.current = true;
    setInputValue(value => `${value.trim()} ${RESUME_NOTE}`);
  }, [inputValue, send, setInputValue]);
}
