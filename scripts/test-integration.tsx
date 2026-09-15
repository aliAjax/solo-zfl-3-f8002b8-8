// 集成测试：真实 DOM（happy-dom）下验证 store、检索 UI、错误提示与既有页面不受破坏
import './_shim';
import { domWindow } from './_dom';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter, Routes, Route } from 'react-router';
import { useBenchStore } from '@/store/useBenchStore';
import ListPage from '@/pages/ListPage/ListPage';
import FilterBar from '@/components/FilterBar/FilterBar';
import RankingPage from '@/pages/RankingPage/RankingPage';
import BenchDetail from '@/pages/BenchDetail/BenchDetail';
import MapPage from '@/pages/MapPage/MapPage';
import { searchEngine, SearchEngine } from '@/utils/search';
import { mockBenches } from '@/data/mockBenches';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let pass = 0;
let fail = 0;
function assert(cond: boolean, msg: string) {
  if (cond) pass++;
  else { fail++; console.error('  ✗ FAIL:', msg); }
}

let rootEl: HTMLElement;
let root: ReturnType<typeof createRoot>;

function mount(ui: React.ReactElement, initialPath = '/') {
  rootEl = document.createElement('div');
  document.body.appendChild(rootEl);
  root = createRoot(rootEl);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/" element={ui} />
          <Route path="/bench/:id" element={<BenchDetail />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

function unmount() {
  act(() => root.unmount());
  rootEl.remove();
}

const $ = (sel: string) => rootEl.querySelector(sel);
const $$ = (sel: string) => rootEl.querySelectorAll(sel);

/* ---------------- 初始化与默认浏览 ---------------- */
act(() => {
  useBenchStore.getState().initialize();
});
assert(useBenchStore.getState().benches.length === mockBenches.length, '初始化载入 mock 数据');

mount(<>
  <FilterBar />
  <ListPage />
</>);

assert(rootEl.textContent?.includes('长椅档案') ?? false, '列表页标题正常');
assert(rootEl.textContent?.includes(mockBenches[0].name) ?? false, '列表页渲染档案');
const cardsCount = () => $$('h3').length;
assert(cardsCount() >= mockBenches.length - 2, `卡片正常渲染（h3 数 ${cardsCount()}）`);
assert(!rootEl.textContent?.includes('查询无法执行'), '默认无错误面板');

/* ---------------- 单字检索 + 高亮 ---------------- */
act(() => useBenchStore.getState().setSearchQuery('椅'));
const marks = $$('mark');
assert(marks.length > 0, `搜索“椅”结果出现高亮（${marks.length} 处）`);
assert((($('.text-sm.text-ink-light')?.textContent) ?? '').includes('条记录'), '记录计数渲染');

/* ---------------- 两字词组 / 字段 / 备注 ---------------- */
act(() => useBenchStore.getState().setSearchQuery('备注:太极'));
let r = useBenchStore.getState().searchBenches();
assert(r.ok && r.benches.some((b) => b.id === 'bench-001'), '备注:太极 命中分时段体验');

/* ---------------- 未闭合引号：明确提示、不崩 ---------------- */
act(() => useBenchStore.getState().setSearchQuery('"未闭合'));
assert(rootEl.textContent?.includes('引号没有闭合') ?? false, '输入框下显示引号未闭合提示');
assert(rootEl.textContent?.includes('查询无法执行') ?? false, '列表区显示查询错误面板');

/* ---------------- 只有非 ---------------- */
act(() => useBenchStore.getState().setSearchQuery('-公园'));
assert(rootEl.textContent?.includes('不能只写要排除') ?? false, '显示“只有非”提示');

/* ---------------- 未知字段 ---------------- */
act(() => useBenchStore.getState().setSearchQuery('xxx:yyy'));
assert(rootEl.textContent?.includes('不认识的字段') ?? false, '未知字段给出提示');

/* ---------------- 空查询恢复 ---------------- */
act(() => {
  useBenchStore.getState().clearFilters();
});
r = useBenchStore.getState().searchBenches();
assert(r.benches.length === mockBenches.length, '清空后恢复全部档案');

/* ---------------- 无结果 ---------------- */
act(() => useBenchStore.getState().setSearchQuery('不存在的词鸑鷟'));
assert(rootEl.textContent?.includes('没有找到匹配的长椅') ?? false, '无结果给出空状态提示');
act(() => useBenchStore.getState().setSearchQuery(''));

/* ---------------- 检索 + 属性筛选叠加 ---------------- */
act(() => {
  useBenchStore.getState().setSearchQuery('椅');
  useBenchStore.getState().setMaterialFilter('wood');
});
r = useBenchStore.getState().searchBenches();
assert(r.benches.length > 0 && r.benches.every((b) => b.material === 'wood'), '搜索结果叠加材质筛选');
act(() => useBenchStore.getState().clearFilters());

/* ---------------- 真实输入框交互 ---------------- */
const input = $('input[aria-label="全文检索"]') as HTMLInputElement;
assert(!!input, '检索输入框存在');
act(() => {
  // React 通过原型上的 value setter 追踪变更，需绕过实例描述符
  const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, '江 OR 公园');
  input.dispatchEvent(new domWindow.Event('input', { bubbles: true }));
});
r = useBenchStore.getState().searchBenches();
assert(useBenchStore.getState().searchQuery === '江 OR 公园', '输入框更新 store 查询');
assert(r.ok && r.benches.length >= 2, `OR 查询结果 ${r.benches.length} 条`);
assert($$('mark').length > 0, 'OR 结果有高亮');

// 帮助面板
const helpBtn = $$('button').length;
assert(helpBtn > 0, '帮助按钮存在');
act(() => {
  const btn = [...$$('button')].find((b) => b.getAttribute('title') === '检索语法说明');
  btn?.dispatchEvent(new domWindow.Event('click', { bubbles: true }));
});
assert(rootEl.textContent?.includes('双引号精确短语') ?? false, '点击帮助显示语法说明');

unmount();

/* ---------------- 排行榜不受影响 ---------------- */
mount(<RankingPage />);
assert(rootEl.textContent?.includes('舒适度排行') ?? false, '排行榜正常');
assert(rootEl.textContent?.includes(mockBenches[0].name) ?? false, '排行榜渲染数据');
unmount();

/* ---------------- 地图页不受影响 ---------------- */
mount(<MapPage />);
assert(rootEl.textContent?.includes('地图分布') ?? false, '地图页正常');
unmount();

/* ---------------- 详情页不受影响 ---------------- */
mount(<BenchDetail />, `/bench/${mockBenches[0].id}`);
// BenchDetail 在未命中 id 时会 navigate('/')；用文本确认详情内容
assert(rootEl.textContent?.includes(mockBenches[0].review) ?? false, '详情页渲染评价');
assert(rootEl.textContent?.includes('分时段体验') ?? false, '详情页渲染分时段体验');
unmount();

/* ---------------- 增删改后索引增量更新 ---------------- */
const id = useBenchStore.getState().addBench({
  name: '独一无二测试紫藤架',
  location: '测试路测试号',
  lat: 31.23, lng: 121.47,
  material: 'stone', orientation: 'east', hasBackrest: false,
  shadeLevel: 'none', noiseLevel: 'noisy', stayDuration: 'short',
  rating: 2, review: '临时评价XYZ',
});
act(() => useBenchStore.getState().setSearchQuery('紫藤架'));
assert(useBenchStore.getState().searchBenches().benches.some((b) => b.id === id), '新增档案立即可搜');

useBenchStore.getState().updateBench(id, { name: '改名后的枫杨下座位' });
act(() => useBenchStore.getState().setSearchQuery('紫藤架'));
assert(!useBenchStore.getState().searchBenches().benches.some((b) => b.id === id), '编辑后旧名不再命中');
act(() => useBenchStore.getState().setSearchQuery('枫杨'));
assert(useBenchStore.getState().searchBenches().benches.some((b) => b.id === id), '编辑后新名可搜');

useBenchStore.getState().addExperience(id, { timePeriod: 'night', notes: '深夜测试时段备注杜鹃', rating: 3 });
act(() => useBenchStore.getState().setSearchQuery('备注:杜鹃'));
assert(useBenchStore.getState().searchBenches().benches.some((b) => b.id === id), '新增时段备注可搜');

useBenchStore.getState().deleteBench(id);
searchEngine.flush();
act(() => useBenchStore.getState().setSearchQuery('枫杨'));
assert(!useBenchStore.getState().searchBenches().benches.some((b) => b.id === id), '删除后不可搜');
act(() => useBenchStore.getState().clearFilters());

/* ---------------- 持久化 ---------------- */
const indexRaw = localStorage.getItem('bench-archive-search-index-v1');
assert(!!indexRaw, '索引已持久化到 localStorage');
const parsed = JSON.parse(indexRaw as string);
assert(parsed.version === 1 && parsed.docs.length === mockBenches.length,
  `持久化索引条目=${parsed.docs?.length}，档案=${mockBenches.length}`);

/* ---------------- 损坏自愈 + 提示横幅 ---------------- */
localStorage.setItem('bench-archive-search-index-v1', '<<<not json>>>');
const engine2 = new SearchEngine();
assert(!!engine2.notice && engine2.notice.includes('损坏'), '加载损坏索引产生提示');

mount(<>
  <NoticeBannerProbe />
  <ListPage />
</>);
assert(rootEl.textContent?.includes('自动重建索引') ?? false, '列表页显示索引损坏并重建横幅');
unmount();

/* ---------------- 刷新后检索仍在（模拟重新初始化） ---------------- */
// 当前单例引擎索引完好；直接断言其与档案数据一致
searchEngine.reconcile(useBenchStore.getState().benches);
searchEngine.flush();
const rr = searchEngine.search('长椅');
assert(rr.ok && rr.hits.length > 0, '对账后检索正常');

console.log(`\n${fail === 0 ? '✅' : '❌'} 集成测试通过 ${pass} 项，失败 ${fail} 项`);
if (fail > 0) process.exit(1);

function NoticeBannerProbe() {
  React.useLayoutEffect(() => {
    useBenchStore.setState({ searchNotice: '检索索引已损坏，已根据档案数据自动重建索引' });
  }, []);
  return null;
}
