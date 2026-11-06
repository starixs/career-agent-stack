/**
 * 开放题和自我介绍（material-draft）的成果：写过、存下来的每一篇；点开看全文。
 * 标出只给哪家公司用、你确认过没有——对同一家前后说法要一致，靠的就是这些存下来的版本。
 */
import { formatDate } from '../../CareerPrimitives';
import type { Material, MaterialKind } from '../../types';

import { Tag } from '../visual';

import { Disclosure, ResultList } from './parts';

const KIND_LABELS: Record<MaterialKind, string> = {
  why_company: '为什么选我们', why_role: '为什么做这个岗位', self_intro: '自我介绍', strength_weakness: '优点和缺点',
  career_plan: '职业规划', project_story: '项目故事', open_question: '开放题', other: '其他',
};
const LENGTH_LABELS: Record<string, string> = { short: '短', medium: '中', long: '长' };

function MaterialRow({ material, open = false }: { material: Material; open?: boolean }) {
  const length = material.length_variant ? LENGTH_LABELS[material.length_variant] : null;
  const meta = [KIND_LABELS[material.kind] ?? material.kind, length && `${length}版`, material.company_scope && `只给${material.company_scope}`].filter(Boolean).join(' · ');
  return (
    <Disclosure
      defaultOpen={open}
      summary={(
        <span className="flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--ink)]">{material.title}</span>
            <span className="block truncate text-xs text-[var(--muted)]">{meta}</span>
          </span>
          {material.confirmed ? <Tag tone="success">你确认过</Tag> : <Tag>草稿</Tag>}
          <span className="shrink-0 text-xs tabular-nums text-[var(--subtle)]">{formatDate(material.updated_at)}</span>
        </span>
      )}
    >
      <p className="max-w-[62ch] whitespace-pre-wrap text-base leading-relaxed text-[var(--ink)]">{material.content}</p>
    </Disclosure>
  );
}

/** openFirst：第一篇先展开（示例里一打开就看到全文）。 */
export function MaterialList({ materials, openFirst = false }: { materials: Material[]; openFirst?: boolean }) {
  return (
    <ResultList label="写过的">
      {materials.map((material, index) => <MaterialRow key={material.id} material={material} open={openFirst && index === 0} />)}
    </ResultList>
  );
}
