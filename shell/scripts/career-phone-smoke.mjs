// 手机连接真机冒烟：走产品同一条后台路径（解析助手 → 列已配对手机 → 绑定 → 等连上并报最近一条验证码 → 解绑）。
// 运行：cd app/shell && node scripts/prepare-phone-helper.mjs && CAREER_DATA_DIR=$(mktemp -d) node --import tsx/esm scripts/career-phone-smoke.mjs [手机蓝牙地址]
// 用临时 CAREER_DATA_DIR，不碰真实求职数据库。手机需已和这台 Mac 配对并允许过访问短信。
import { phoneLink } from '../src/server/career/phone/index.ts';

const WAIT_CONNECTED_MS = 90_000;
const POLL_MS = 500;

if (!process.env.CAREER_DATA_DIR) { console.error('请设置临时 CAREER_DATA_DIR'); process.exit(64); }

const svc = await phoneLink();
const phones = await svc.pairedPhones();
console.log('电脑名:', await svc.computerName());
console.log('已配对手机:', phones.map(p => `${p.name}(${p.address}${p.connected ? ', 已连' : ''})`).join('、') || '无');
const target = phones.find(p => p.address === process.argv[2]) ?? phones.find(p => p.connected) ?? phones[0];
if (!target) { console.error('没有已配对的手机'); process.exit(1); }

console.log(`绑定 ${target.name} …`);
await svc.bind(target.address, target.name);
const end = Date.now() + WAIT_CONNECTED_MS;
while (Date.now() < end) {
  const s = svc.status();
  if (s.state === 'connected' && s.latest) break;
  if (['unsupported', 'refused', 'helper_missing'].includes(s.state)) break;
  await new Promise(r => setTimeout(r, POLL_MS));
}
const s = svc.status();
console.log('状态:', s.state);
console.log('最近一条:', s.latest ? `【${s.latest.signature ?? '-'}】${s.latest.code ?? '(没取到码)'} 收到于 ${s.latest.received_at}` : '无');
svc.unbind();
await svc.stop();
console.log('解绑后:', svc.status().state, svc.status().binding);
process.exit(s.state === 'connected' && s.latest?.code ? 0 : 1);
