/**
 * 给验证码截图叠编号（Set-of-Mark）：点选叠网格并给每格编号，滑块在顶部叠刻度。
 * 视觉模型报编号比报像素准得多；编号和 captcha-solver.ts 的 gridOf / cellCenter 用同一套行列（行列按 CSS 尺寸算，画的时候按截图实际尺寸均分）。
 */
import type { GridMarks } from './captcha-solver';

const LINE = 'rgba(255,0,80,0.55)';
const LABEL = '#ff0050';

function gridSvg(w: number, h: number, m: GridMarks): string {
  const cw = w / m.cols; const ch = h / m.rows;
  const parts: string[] = [];
  for (let c = 1; c < m.cols; c++) parts.push(`<line x1="${c * cw}" y1="0" x2="${c * cw}" y2="${h}" stroke="${LINE}" stroke-width="1"/>`);
  for (let r = 1; r < m.rows; r++) parts.push(`<line x1="0" y1="${r * ch}" x2="${w}" y2="${r * ch}" stroke="${LINE}" stroke-width="1"/>`);
  for (let i = 0; i < m.cols * m.rows; i++) {
    const x = (i % m.cols) * cw + 2; const y = Math.floor(i / m.cols) * ch + 10;
    parts.push(`<text x="${x}" y="${y}" font-size="9" font-family="Arial" fill="${LABEL}" stroke="white" stroke-width="0.6" paint-order="stroke">${i + 1}</text>`);
  }
  return parts.join('');
}

function ticksSvg(w: number, m: GridMarks): string {
  const parts: string[] = [];
  // 截图可能是 2 倍像素（Retina）：刻度按图宽均分，每格对应 CSS 里的 m.cell 像素
  const step = w / m.cols;
  for (let i = 0; i <= m.cols; i++) {
    const x = i * step;
    parts.push(`<line x1="${x}" y1="0" x2="${x}" y2="${i % 5 === 0 ? 10 : 5}" stroke="${LABEL}" stroke-width="1"/>`);
    if (i % 5 === 0) parts.push(`<text x="${x + 1}" y="19" font-size="9" font-family="Arial" fill="${LABEL}" stroke="white" stroke-width="0.6" paint-order="stroke">${i}</text>`);
  }
  return parts.join('');
}

export async function overlayMarks(png: Buffer, marks: GridMarks): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const img = sharp(png);
  const { width = 0, height = 0 } = await img.metadata();
  const body = marks.kind === 'grid' ? gridSvg(width, height, marks) : ticksSvg(width, marks);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`);
  return img.composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}
