/**
 * 公司标识（规范 CAREER_INTELLIGENT_UI.md §6.2、§8 CompanyMark）：一份申请的图形里，上半标志区用什么。
 *
 * 标志分三类：自带色块的（美团黄）铺满品牌色；其余官方标志 / 字标放浅底；找不到标志的写公司名。
 * 「做到可用即可，不求每家都有标志」：这里只登记随产品打包的那几家官方标志（渲染端按 logo 键取文件），
 * 其余一律回落到名字。判断只在这里做一份，服务端下发，前端不按公司名自己猜。
 */

export interface CompanyMark {
  /** company 表的 id；岗位只记了公司名时为 null */
  company_id: string | null
  /** 写在标志区或悬停提示里的公司名（原样，不截断） */
  name: string
  /** 随产品打包的官方标志键；缺省 = 写名字 */
  logo?: string
  /** 色块类的品牌色：标志区整块铺这个颜色 */
  fill?: string
}

interface BrandEntry { logo: string; aliases: readonly string[]; fill?: string }

/**
 * 打包的官方标志（来源：Wikimedia Commons，同预览 specs/career-mockups/intelligent-ui/img/logo）。
 * aliases 按「公司名里包含它」匹配，长的写在前面，避免「腾讯混元」被短别名抢走。
 */
const BRANDS: readonly BrandEntry[] = [
  { logo: 'mt', aliases: ['美团', 'meituan'], fill: '#ffd100' },
  { logo: 'jd', aliases: ['京东', 'jd.com'] },
  { logo: 'hw', aliases: ['华为', 'huawei'] },
  { logo: 'ds', aliases: ['deepseek', '深度求索'] },
  { logo: 'zx', aliases: ['中兴', 'zte'] },
  { logo: 'zj', aliases: ['字节跳动', '字节', 'bytedance'] },
  { logo: 'pdd', aliases: ['拼多多', 'pinduoduo', 'temu'] },
  { logo: 'mx', aliases: ['摩尔线程'] },
  { logo: 'zy', aliases: ['智元'] },
  { logo: 'xf', aliases: ['科大讯飞', '讯飞', 'iflytek'] },
  { logo: 'lx', aliases: ['理想汽车', '理想'] },
  { logo: 'hy', aliases: ['腾讯混元', '混元'] },
  { logo: 'al', aliases: ['阿里巴巴', '阿里', 'alibaba'] },
  { logo: 'ry', aliases: ['荣耀', 'honor'] },
  { logo: 'cf', aliases: ['长飞'] },
  { logo: 'lf', aliases: ['联发科', 'mediatek'] },
  { logo: 'dj', aliases: ['大疆', 'dji'] },
  { logo: 'pd', aliases: ['普渡'] },
]

const normalize = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/** 公司名 → 标识。没有公司名时写「未知公司」，仍是名字类。 */
export function companyMarkOf(name: string | null | undefined, companyId: string | null = null): CompanyMark {
  const display = name?.trim() || '未知公司'
  const key = normalize(display)
  const brand = BRANDS.find(b => b.aliases.some(a => key.includes(normalize(a))))
  if (!brand) return { company_id: companyId, name: display }
  return { company_id: companyId, name: display, logo: brand.logo, ...(brand.fill ? { fill: brand.fill } : {}) }
}

/** 打包了标志的全部键（渲染端核对资源是否齐全用）。 */
export const COMPANY_LOGO_KEYS: readonly string[] = BRANDS.map(b => b.logo)
