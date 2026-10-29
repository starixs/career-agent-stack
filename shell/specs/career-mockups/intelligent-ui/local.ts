/**
 * 本机私密素材：简历页图、证件照、真名放在 local/（已在 .gitignore），不进仓库。
 * 缺了就用占位，预览照样能跑。
 */
const files = import.meta.glob('./local/*.{png,jpg}', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const meFile = import.meta.glob('./local/me.json', { eager: true, import: 'default' }) as Record<string, { name?: string; lede?: string }>;

const svg = (w: number, h: number, body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#f4f1ea"/>${body}</svg>`)}`;
const lines = Array.from({ length: 14 }, (_, i) => `<rect x="40" y="${90 + i * 38}" width="${i % 4 === 3 ? 260 : 515}" height="10" rx="3" fill="#d9d3c7"/>`).join('');

export const pagePng = files['./local/page.png'] ?? svg(595, 842, `<rect x="40" y="40" width="200" height="22" rx="4" fill="#8f877a"/>${lines}`);
export const photoJpg = files['./local/photo.jpg'] ?? svg(300, 400, '<circle cx="150" cy="150" r="70" fill="#d9d3c7"/><rect x="60" y="250" width="180" height="150" rx="80" fill="#d9d3c7"/>');

const me = meFile['./local/me.json'] ?? {};
export const ME = { name: me.name ?? '你的名字', lede: me.lede ?? '某大学计算机硕士，2026 届。做过高并发后端。' };
