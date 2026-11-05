/**
 * 计费清单：模型、工具、语音的单价，赠送，套餐与充值档。数值全部来自 /billing/price-list（@career/core 的 buildPriceList），这里不抄数。
 */
import { Card } from '../CareerPrimitives';
import { yuan, type PriceList } from './accountModel';

const PERIOD_LABEL = { month: '月', quarter: '季' } as const;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-t border-[var(--line)]">
      <td className="py-2 pr-4 text-[var(--ink)]">{label}</td>
      <td className="py-2 text-right tabular-nums text-[var(--muted)]">{value}</td>
    </tr>
  );
}

export function PriceListCard({ list }: { list: PriceList }) {
  const perYuan = 100 / list.creditUnitPriceCents;
  return (
    <Card title="计费清单">
      <div className="mb-2 text-[length:var(--text-xs)] text-[var(--muted)]">1 元 = {perYuan} 积分</div>
      <table className="w-full text-[length:var(--text-sm)]">
        <tbody>
          {list.models.map(m => (
            <Row key={m.model} label={`${m.label}（每百万 token）`} value={`输入 ${m.inputPerMillion} · 输出 ${m.outputPerMillion} · 缓存命中 ${m.cachePerMillion}`} />
          ))}
          {list.tools.filter(t => t.credits > 0).map(t => <Row key={t.tool} label={t.label} value={`${t.credits} 积分 / 次`} />)}
          <Row label="面试录音转写" value={`${Math.round(list.asr.freeSeconds / 60)} 分钟内免费，超出 ${list.asr.creditsPerMinute} 积分 / 分钟`} />
          <Row label="开户赠送" value={`${list.signupGrantCredits} 积分`} />
          <Row label="每日签到" value={`${list.checkinDailyCredits.free ?? 0} 积分（会员 ${Math.max(0, ...Object.values(list.checkinDailyCredits))}）`} />
          {list.plans.map(p => <Row key={p.id} label={p.name} value={`${yuan(p.priceCents)} / ${PERIOD_LABEL[p.billingPeriod]} · ${p.creditsGranted} 积分`} />)}
          <Row label="充值" value={list.topupPackages.map(p => `${yuan(p.priceCents)} ${p.credits}`).join(' · ')} />
        </tbody>
      </table>
    </Card>
  );
}
