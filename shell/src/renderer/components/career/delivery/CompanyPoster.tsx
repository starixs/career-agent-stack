/**
 * 公司海报（规范 §6.2）：一份申请的图形，四档大小。上半标志区随品牌变（色块 / 字标 / 名字），
 * 下半统一浅底写岗位和状态字；状态只看最底下一条。标志键与品牌色由服务端 CompanyMark 给，这里只按键取打包的文件。
 */
import type { CSSProperties } from 'react';

import type { CompanyMark, PosterState } from './deliveryApi';

import './delivery.css';

const LOGOS = import.meta.glob('../../../assets/company-logos/*', { eager: true, query: '?url', import: 'default' }) as Record<string, string>;
const LOGO_BY_KEY: Record<string, string> = Object.fromEntries(Object.entries(LOGOS).map(([path, url]) => [path.split('/').pop()!.split('.')[0], url]));

export type PosterSize = 'lg' | 'md' | 'sm' | 'xs';
/** 名字到这个长度起用小一号字，免得横长小签放不下。 */
const LONG_NAME = 4;

export function CompanyPoster({ company, size, state = 'done', role, over, star }: {
  company: CompanyMark; size: PosterSize; state?: PosterState; role?: string; over?: string; star?: boolean;
}) {
  const logo = company.logo ? LOGO_BY_KEY[company.logo] : undefined;
  const fill = logo ? company.fill : undefined;
  const classes = ['cd-poster', `cd-p-${size}`, `cd-s-${state}`, company.name.length >= LONG_NAME ? 'cd-p-long' : '', fill ? 'cd-p-fill' : ''].filter(Boolean).join(' ');
  return (
    <span className={classes} style={fill ? { '--mark': fill } as CSSProperties : undefined} title={role ? `${company.name} · ${role}` : company.name} data-testid="company-poster" data-state={state}>
      <span className="cd-p-mark">{logo ? <img src={logo} alt={company.name} draggable={false} /> : <span className="cd-p-co font-human">{company.name}</span>}</span>
      {(size === 'lg' || size === 'md') && (
        <span className="cd-p-body">
          {role && <span className="cd-p-role">{role}</span>}
          {over && <span className="cd-p-over">{over}</span>}
        </span>
      )}
      {star && size !== 'xs' && <i className="cd-p-star" aria-label="目标">★</i>}
    </span>
  );
}

/** 一件事涉及多家时，等你条里的小签：写「N 家」，不留一个光秃秃的数。 */
export function CountTag({ n }: { n: number }) {
  return <span className="cd-poster cd-p-xs cd-s-ask cd-p-num" role="img" aria-label={`这件事涉及 ${n} 家`} title={`这件事涉及 ${n} 家`}><span className="cd-p-co">{n} 家</span></span>;
}
