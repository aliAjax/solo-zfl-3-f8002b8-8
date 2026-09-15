// 临时测试脚本：检索引擎功能与性能验证
import './_shim';
import { SearchEngine, parseQuery } from '../src/utils/search';
import type { Bench } from '../src/types';

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', msg); }
}
function hasAll(hits: { benchId: string }[], ids: string[]): boolean {
  const set = new Set(hits.map((h) => h.benchId));
  return ids.every((id) => set.has(id));
}

function makeBench(id: string, name: string, location: string, review: string, notes: string[] = []): Bench {
  return {
    id, name, location, lat: 31.23, lng: 121.47,
    material: 'wood', orientation: 'south', hasBackrest: true,
    shadeLevel: 'partial', noiseLevel: 'moderate', stayDuration: 'medium',
    rating: 4, review,
    experiences: notes.map((n, i) => ({ id: `${id}-e${i}`, benchId: id, timePeriod: 'morning' as const, notes: n, rating: 4 })),
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z',
  };
}

const benches = [
  makeBench('b1', '梧桐树下的老长椅', '人民公园东门北侧', '公园里最爱的长椅，夏天梧桐叶茂盛时完全遮阴，偶尔能听到鸟鸣。', ['早晨有老人打太极', '下午最凉快适合看书']),
  makeBench('b2', '江边金属长椅', '滨江大道观景台旁', '视野很好能看到江景，但是夏天太烫，冬天又太凉。', ['傍晚江风很大']),
  makeBench('b3', '人民广场木椅', '人民广场南侧地铁站旁', '人来人往很热闹，木椅坐着还算舒服。', []),
  makeBench('b4', '湖畔石凳', '人民公园西湖边', '石凳夏天凉快，夜里有蛙鸣。', ['夜晚适合赏月', '夜里能听见蛙鸣阵阵']),
  makeBench('b5', '塑料休息椅', '购物中心门口', '临时歇脚可以，晒久了会褪色。', []),
];

const engine = new SearchEngine();
engine.bulkAdd(benches);
assert(engine.size() === 5, 'bulkAdd 5 docs');

// ---- 基本命中 ----
let r = engine.search('长椅');
assert(r.ok && r.hits.some((h) => h.benchId === 'b1'), '两字词组“长椅”命中 b1');
assert(r.ok && r.hits.some((h) => h.benchId === 'b2'), '两字词组“长椅”命中 b2');
assert(!r.hits.some((h) => h.benchId === 'b3'), '“长椅”不命中名称为木椅的 b3');

r = engine.search('椅');
assert(r.ok && r.hits.length === 4, `单字“椅”命中全部4把椅子（实际${r.hits.length}）`);

// ---- 相关度排序：名称命中 > 位置命中 ----
r = engine.search('人民');
const idxB3 = r.hits.findIndex((h) => h.benchId === 'b3'); // 名称“人民广场”
const idxB1 = r.hits.findIndex((h) => h.benchId === 'b1'); // 位置“人民公园”
assert(idxB3 >= 0 && idxB1 >= 0 && idxB3 < idxB1, '名称命中(b3)排在位置命中(b1)之前');

// ---- 多词 AND ----
r = engine.search('人民 公园');
assert(r.ok && hasAll(r.hits, ['b1', 'b4']), 'AND“人民 公园”命中 b1/b4');
assert(!r.hits.some((h) => h.benchId === 'b3'), 'AND 排除只有人民没有公园的 b3');

// ---- OR ----
r = engine.search('江 OR 湖');
assert(r.ok && hasAll(r.hits, ['b2', 'b4']), 'OR 命中江/湖');

r = engine.search('江,湖');
assert(r.ok && hasAll(r.hits, ['b2', 'b4']), '逗号 OR 命中');

// ---- NOT ----
r = engine.search('人民 -广场');
assert(r.ok && r.hits.some((h) => h.benchId === 'b1') && !r.hits.some((h) => h.benchId === 'b3'), 'NOT 排除广场 b3');

r = engine.search('-长椅');
assert(!r.ok && r.error?.code === 'NO_POSITIVE', '只有非 -> NO_POSITIVE');

// ---- 短语 ----
r = engine.search('"人民公园"');
assert(r.ok && hasAll(r.hits, ['b1', 'b4']), '短语“人民公园”命中位置');
assert(!r.hits.some((h) => h.benchId === 'b3'), '短语不命中“人民广场”');

r = engine.search('"人民广场"');
assert(r.ok && r.hits.length === 1 && r.hits[0].benchId === 'b3', '短语“人民广场”只命中 b3');

// 未闭合引号
r = engine.search('"人民公园');
assert(!r.ok && r.error?.code === 'UNTERMINATED_QUOTE', '未闭合引号 -> 错误');

// ---- 字段限定 ----
r = engine.search('名称:长椅');
assert(r.ok && r.hits.some((h) => h.benchId === 'b1') && r.hits.some((h) => h.benchId === 'b2'), '字段 名称: 命中');
assert(!r.hits.some((h) => h.benchId === 'b4'), '名称:长椅 不命中石凳 b4');

r = engine.search('location:滨江');
assert(r.ok && r.hits.length === 1 && r.hits[0].benchId === 'b2', 'location: 字段限定命中 b2');

r = engine.search('备注:蛙鸣');
assert(r.ok && r.hits.length === 1 && r.hits[0].benchId === 'b4', '备注: 命中分时段体验 b4');

r = engine.search('评价:江景');
assert(r.ok && r.hits[0].benchId === 'b2', '评价: 命中 review');

r = engine.search('foo:bar');
assert(!r.ok && r.error?.code === 'UNKNOWN_FIELD', '未知字段报错');

r = engine.search('名称:');
assert(!r.ok && r.error?.code === 'EMPTY_TERM', '字段后空内容报错');

// 字段 + 引号
r = engine.search('位置:"人民公园"');
assert(r.ok && r.hits.length >= 2, '字段+短语 位置:"人民公园"');
assert(!r.hits.some((h) => h.benchId === 'b3'), '字段+短语 不命中广场');

// ---- 空查询 ----
r = engine.search('');
assert(!r.ok && r.error?.code === 'EMPTY', '空查询 -> EMPTY');
r = engine.search('   ');
assert(!r.ok && r.error?.code === 'EMPTY', '空白查询 -> EMPTY');
r = engine.search('...');
assert(!r.ok && r.error?.code === 'EMPTY_TERM', '纯标点 -> EMPTY_TERM');

// ---- 单字 vs 两字词组同时可搜 ----
r = engine.search('鸟');
assert(r.ok && r.hits.some((h) => h.benchId === 'b1'), '单字“鸟”命中评价中的鸟鸣');

// ---- 混合：(人民 OR 江) 非 金属 ----
r = engine.search('人民 OR 江 -金属');
assert(r.ok && !r.hits.some((h) => h.benchId === 'b2'), 'OR + NOT：排除金属 b2');
assert(r.hits.some((h) => h.benchId === 'b1'), 'OR + NOT：保留 b1');

// ---- 高亮片段 ----
r = engine.search('蛙鸣');
const hit = r.hits.find((h) => h.benchId === 'b4');
assert(!!hit, '蛙鸣命中 b4');
const seg = hit?.snippets.find((s) => s.field === 'notes');
assert(!!seg && seg.segments.some((x) => x.match && x.text.includes('蛙鸣')), '备注片段标出关键词');

r = engine.search('江景');
const hit2 = r.hits.find((h) => h.benchId === 'b2');
const seg2 = hit2?.snippets.find((s) => s.field === 'review');
assert(!!seg2 && seg2.segments.some((x) => x.match && x.text.includes('江景')), '评价片段标出关键词');

// ---- 稳定排序：同分顺序固定 ----
const small = new SearchEngine();
small.bulkAdd([
  makeBench('a', '公园椅甲', '同位置', '同样的评价文字'),
  makeBench('b', '公园椅乙', '同位置', '同样的评价文字'),
  makeBench('c', '公园椅丙', '同位置', '同样的评价文字'),
]);
const q1 = small.search('公园').hits.map((h) => h.benchId).join(',');
const q2 = small.search('公园').hits.map((h) => h.benchId).join(',');
assert(q1 === q2 && q1 === 'a,b,c', `同分稳定排序（实际 ${q1}）`);

// ---- 增量更新 ----
// 新增
engine.upsert(makeBench('b6', '新增的藤椅', '中山公园', '新椅子'));
assert(engine.size() === 6, '增量新增 size=6');
r = engine.search('藤椅');
assert(r.ok && r.hits.some((h) => h.benchId === 'b6'), '新增立即可搜');
// 修改
engine.upsert(makeBench('b6', '改名藤椅', '中山公园西门', '改后的评价，提到银杏'));
r = engine.search('银杏');
assert(r.ok && r.hits.some((h) => h.benchId === 'b6'), '修改后新词可搜');
r = engine.search('新增的藤椅');
assert(!r.hits.some((h) => h.benchId === 'b6'), '修改后旧词不再命中');
// 删除
engine.remove('b6');
assert(engine.size() === 5, '删除后 size=5');
r = engine.search('银杏');
assert(!r.hits.some((h) => h.benchId === 'b6'), '删除后不可搜');

// ---- 持久化：刷新后仍在 ----
engine.upsert(makeBench('b7', '持久化竹椅', '徐汇公园', '刷新测试'));
engine.flush();
assert(!!localStorage.getItem('bench-archive-search-index-v1'), '索引已写入 localStorage');
const engine2 = new SearchEngine();
assert(engine2.size() === 6, `刷新后加载 6 条（实际 ${engine2.size()}）`);
r = engine2.search('竹椅');
assert(r.ok && r.hits.some((h) => h.benchId === 'b7'), '刷新后索引仍可检索');
assert(engine2.notice === null, '正常索引无提示');

// ---- 索引损坏自愈 ----
localStorage.setItem('bench-archive-search-index-v1', '{ this is : broken json,,,');
const engine3 = new SearchEngine();
assert(!!engine3.notice && engine3.notice.includes('损坏'), '损坏索引给出明确提示');
assert(engine3.size() === 0, '损坏后清空内存索引');
engine3.bulkAdd(benches);
engine3.flush();
const engine4 = new SearchEngine();
assert(engine4.size() === 5, '重建后刷新恢复正常');

// 结构损坏
localStorage.setItem('bench-archive-search-index-v1', JSON.stringify({ version: 99, docs: 'bad' }));
const engine5 = new SearchEngine();
assert(!!engine5.notice, '版本不兼容给出提示');

// ---- 500+ 性能 ----
const big: Bench[] = [];
const wordsN = ['梧桐', '香樟', '银杏', '水杉', '悬铃木', '垂柳', '槐树', '枫树', '玉兰', '桂花'];
const wordsL = ['人民公园', '滨江大道', '中山公园', '世纪广场', '徐汇绿地', '静安寺旁', '外滩', '陆家嘴', '苏州河畔', '社区门口'];
for (let i = 0; i < 600; i++) {
  big.push(makeBench(
    `big-${i}`,
    `${wordsN[i % wordsN.length]}下的长椅${i}号`,
    `${wordsL[i % wordsL.length]}第${i % 50}个路口`,
    `这是第${i}张长椅，${wordsN[(i + 3) % wordsN.length]}遮阴不错，适合休息看书。`,
    [`早晨阳光${i}`, `傍晚人多${i}`, `夜晚安静${i}`],
  ));
}
const bigEngine = new SearchEngine();
let t0 = performance.now();
bigEngine.bulkAdd(big);
const buildMs = performance.now() - t0;

t0 = performance.now();
for (let i = 0; i < 50; i++) {
  const rr = bigEngine.search('长椅 公园');
  if (rr.hits.length === 0) throw new Error('perf query empty');
}
const queryMs = (performance.now() - t0) / 50;

t0 = performance.now();
let pr = bigEngine.search('"人民公园" 长椅 -金属 OR 银杏 名称:长椅');
const complexMs = performance.now() - t0;
console.log(`  [性能] 构建600条: ${buildMs.toFixed(1)}ms, 平均查询: ${queryMs.toFixed(2)}ms, 复杂查询: ${complexMs.toFixed(2)}ms, 命中 ${pr.hits.length}`);
assert(buildMs < 1000, `600条构建 <1s（${buildMs.toFixed(0)}ms）`);
assert(queryMs < 50, `平均查询 <50ms（${queryMs.toFixed(1)}ms）`);
assert(pr.ok, '复杂查询不报错');

// 增量性能
t0 = performance.now();
bigEngine.upsert(makeBench('big-new', '新增大长椅', '新位置', '新评价'));
const incMs = performance.now() - t0;
assert(incMs < 20, `单条增量更新 <20ms（${incMs.toFixed(1)}ms）`);

// 大写英文/数字
bigEngine.upsert(makeBench('b8', 'Bench Number 42', 'Road 99', 'Nice seat ABC'));
r = bigEngine.search('bench');
assert(r.ok && r.hits.some((h) => h.benchId === 'b8'), '英文不区分大小写');
r = bigEngine.search('42');
assert(r.ok && r.hits.some((h) => h.benchId === 'b8'), '数字可搜');
r = bigEngine.search('名称:bench');
assert(r.ok && r.hits.some((h) => h.benchId === 'b8'), '英文字段限定');

// 中文短语里夹空格/标点的容错
bigEngine.upsert(makeBench('b9', '某椅', '人民 公园', '评价'));
r = bigEngine.search('"人民公园"');
assert(r.ok && r.hits.some((h) => h.benchId === 'b9'), '短语容忍中文间空格');

// 解析器结构检查
const pq = parseQuery('人民 OR 江 -金属 名称:椅 "看书 打盹"');
if ('groups' in pq) {
  assert(pq.groups.length === 3, `DNF组数=3（实际${pq.groups.length}）`);
  assert(pq.groups[0].atoms.length === 2, '第一组为 OR 双原子');
  assert(pq.negative.length === 1, '1个负原子');
} else {
  assert(false, '复杂查询解析失败');
}

console.log(`\n${fail === 0 ? '✅' : '❌'} 通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);
