import type { FileChooserLike } from '../../career/file-chooser'
import type { BridgeCdp } from './bridge-cdp'

type Session = Awaited<ReturnType<BridgeCdp['acquire']>>

/** Intercept only while product input owns a debugger lease; never patch the user's DOM globally. */
export async function interceptFileChooser(session: Session, url: () => string, offer: (chooser: FileChooserLike) => void): Promise<void> {
  session.on('Page.fileChooserOpened', ((event: { backendNodeId?: number; mode?: string }) => {
    if (!event.backendNodeId) return
    const object = session.send('DOM.resolveNode', { backendNodeId: event.backendNodeId }) as Promise<{ object: { objectId: string } }>
    const call = async (functionDeclaration: string, args: unknown[] = []) => {
      const { object: node } = await object
      const result = await session.send('Runtime.callFunctionOn', {
        objectId: node.objectId, functionDeclaration, arguments: args.map(value => ({ value })), returnByValue: true,
      }) as { result?: { value?: unknown }; exceptionDetails?: unknown }
      if (result.exceptionDetails) throw new Error('文件选择框已失效，请重新点上传')
      return result.result?.value
    }
    offer({
      isMultiple: () => event.mode === 'selectMultiple',
      page: () => ({ url }),
      element: () => ({ getAttribute: async name => (await call('function(name) { return this.getAttribute(name); }', [name])) as string | null }),
      setFiles: async files => {
        await call(`function(files) {
          if (!this.isConnected || this.type !== 'file') throw new Error('File input detached');
          const dt = new DataTransfer();
          for (const f of files) dt.items.add(new File([Uint8Array.from(atob(f.data), c => c.charCodeAt(0))], f.name, {type: f.mimeType}));
          this.files = dt.files;
          this.dispatchEvent(new Event('input', {bubbles:true}));
          this.dispatchEvent(new Event('change', {bubbles:true}));
        }`, [files.map(f => ({ name: f.name, mimeType: f.mimeType, data: f.buffer.toString('base64') }))])
      },
      dispose: async () => {
        const { object: node } = await object
        await session.send('Runtime.releaseObject', { objectId: node.objectId }).catch(() => {})
      },
    })
  }) as (...args: never[]) => void)
  await session.send('Page.setInterceptFileChooserDialog', { enabled: true })
}
