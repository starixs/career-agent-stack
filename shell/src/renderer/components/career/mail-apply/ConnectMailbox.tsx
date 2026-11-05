/**
 * 卡组上面那一层「连邮箱」：复用现有的邮箱连接（MailConnectCenter）。
 * Esc 只关这一层：在窗口捕获阶段先接住并标成已处理，卡组的 Esc 看到已处理就不收起（F6）。
 */
import { useEffect, useRef } from 'react';

import OverlayBackdrop from '@/components/OverlayBackdrop';
import { useCloseLayer } from '@/hooks/useCloseLayer';

import { MailConnectCenter } from '../mail-connect/MailConnectCenter';

/** 与 className 里的 z-[60] 一致：在卡组之上、邮箱连接弹窗（70）之下。 */
const CONNECT_Z = 60;

function useEscCloses(onClose: () => void) {
  const latest = useRef(onClose);
  useEffect(() => { latest.current = onClose; });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);
}

export function ConnectMailbox({ onClose, onConnected }: { onClose: () => void; onConnected: () => void }) {
  useCloseLayer(() => { onClose(); return true; }, CONNECT_Z);
  useEscCloses(onClose);
  return (
    <OverlayBackdrop onClose={onClose} className="z-[60] px-4" portal>
      <div role="dialog" aria-modal="true" aria-label="连邮箱" className="cm-connect">
        <MailConnectCenter from="chat" onConnected={onConnected} />
        <button type="button" className="cd-later cm-connect-close" onClick={onClose}>收起</button>
      </div>
    </OverlayBackdrop>
  );
}
