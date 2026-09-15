import { useEffect } from 'react';
import { useBenchStore } from '@/store/useBenchStore';
import FilterBar from '@/components/FilterBar/FilterBar';
import BenchCard from '@/components/BenchCard/BenchCard';
import { Armchair, AlertCircle, Wrench } from 'lucide-react';

export default function ListPage() {
  const {
    benches,
    searchBenches,
    initialize,
    initialized,
    searchQuery,
    searchNotice,
    clearSearchNotice,
  } = useBenchStore();
  const searchResult = searchBenches();
  const { benches: resultBenches, snippetsById, ok, error } = searchResult;
  const isSearching = searchQuery.trim().length > 0;

  useEffect(() => {
    if (!initialized) {
      initialize();
    }
  }, [initialized, initialize]);

  return (
    <div className="container mx-auto px-4 py-6">
      <div className="mb-6">
        <h2 className="font-serif text-2xl font-semibold text-deep-brown mb-1">
          长椅档案
        </h2>
        <p className="text-ink-light text-sm">
          记录城市中那些被忽略的休憩角落
        </p>
      </div>

      {searchNotice && (
        <div className="mb-4 flex items-start gap-2 px-4 py-3 rounded-lg bg-ochre/10 border border-ochre/30 text-sm text-deep-brown">
          <Wrench className="w-4 h-4 text-ochre flex-shrink-0 mt-0.5" />
          <span className="flex-1">{searchNotice}</span>
          <button
            onClick={clearSearchNotice}
            className="text-ink-light hover:text-deep-brown text-xs flex-shrink-0"
          >
            知道了
          </button>
        </div>
      )}

      <FilterBar />

      {ok && resultBenches.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {resultBenches.map((bench, index) => (
            <BenchCard
              key={bench.id}
              bench={bench}
              index={index}
              snippets={isSearching ? snippetsById.get(bench.id) : undefined}
            />
          ))}
        </div>
      ) : !ok && error ? (
        <div className="paper-texture rounded-xl shadow-paper p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-red-400" />
          </div>
          <h3 className="font-serif text-lg font-medium text-deep-brown mb-2">
            查询无法执行
          </h3>
          <p className="text-ink-light text-sm whitespace-pre-line">{error.message}</p>
        </div>
      ) : (
        <div className="paper-texture rounded-xl shadow-paper p-12 text-center">
          <div className="w-16 h-16 rounded-full bg-moss-green/10 flex items-center justify-center mx-auto mb-4">
            <Armchair className="w-8 h-8 text-moss-green/50" />
          </div>
          <h3 className="font-serif text-lg font-medium text-deep-brown mb-2">
            {benches.length === 0
              ? '还没有长椅档案'
              : isSearching
                ? '没有找到匹配的长椅'
                : '当前筛选条件下没有长椅'}
          </h3>
          <p className="text-ink-light text-sm">
            {benches.length === 0
              ? '点击右上角的添加按钮，记录第一张长椅档案吧'
              : isSearching
                ? '试试更换关键词，或用 OR 扩大范围、减少排除词'
                : '试试调整筛选条件或搜索关键词'}
          </p>
        </div>
      )}
    </div>
  );
}
