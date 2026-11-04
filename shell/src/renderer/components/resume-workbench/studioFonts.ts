/** 简历预览字体：一次性把模板字体的 CDN 地址改写到侧车字体缓存（渲染层 CSP 不能直连字体 CDN）。 */
import { globalBaseUrl } from '@/components/career/useGlobalLive';

let fontsReady: Promise<void> | null = null;

export function prepareFonts(): Promise<void> {
  if (!fontsReady) {
    fontsReady = (async () => {
      const [{ setWebFontUrlRewriter }, base] = await Promise.all([import('@career/resume-studio/fonts'), globalBaseUrl()]);
      if (base) setWebFontUrlRewriter(url => `${base}/api/career/live/font?u=${encodeURIComponent(url)}`);
    })();
  }
  return fontsReady;
}
