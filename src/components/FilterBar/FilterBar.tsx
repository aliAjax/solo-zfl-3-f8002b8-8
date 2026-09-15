import { useState } from 'react';
import { Search, X, AlertCircle, HelpCircle } from 'lucide-react';
import { useBenchStore } from '@/store/useBenchStore';
import { MATERIAL_LABELS, ORIENTATION_LABELS, SHADE_LABELS, NOISE_LABELS } from '@/types';
import type { MaterialType, OrientationType, ShadeLevelType, NoiseLevelType } from '@/types';

export default function FilterBar() {
  const {
    searchQuery,
    materialFilter,
    orientationFilter,
    shadeFilter,
    noiseFilter,
    setSearchQuery,
    setMaterialFilter,
    setOrientationFilter,
    setShadeFilter,
    setNoiseFilter,
    clearFilters,
    searchBenches,
  } = useBenchStore();

  const [showHelp, setShowHelp] = useState(false);

  const hasFilters = searchQuery || materialFilter || orientationFilter || shadeFilter || noiseFilter;
  const result = searchBenches();
  const filteredCount = result.ok ? result.benches.length : 0;
  const queryError = !result.ok && searchQuery.trim() ? result.error : null;

  return (
    <div className="paper-texture rounded-xl shadow-paper p-4 mb-6">
      <div className="flex flex-col gap-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-ink-light" />
          <input
            type="text"
            placeholder="搜索名称、位置、评价、分时段备注…  如：人民公园 OR 滨江 -金属"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="全文检索"
            className={`w-full pl-10 pr-20 py-2.5 bg-white/50 border rounded-lg text-deep-brown placeholder:text-ink-light/60 focus:bg-white transition-colors ${
              queryError ? 'border-red-400' : 'border-deep-brown/10'
            }`}
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowHelp((v) => !v)}
              title="检索语法说明"
              className="text-ink-light hover:text-moss-green transition-colors"
            >
              <HelpCircle className="w-4 h-4" />
            </button>
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="text-ink-light hover:text-deep-brown"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {queryError && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>{queryError.message}</span>
          </div>
        )}

        {showHelp && (
          <div className="text-xs leading-relaxed text-ink-light bg-warm-cream/60 border border-deep-brown/10 rounded-lg px-4 py-3 space-y-1">
            <p className="font-medium text-deep-brown">检索语法</p>
            <p>· 空格分隔多个词，默认「与」：<code className="bg-white/70 px-1 rounded">公园 长椅</code></p>
            <p>· 「或」用 OR（也可用逗号、|、或）：<code className="bg-white/70 px-1 rounded">江 OR 湖</code></p>
            <p>· 「非」用词前加 -（也可用 NOT、非）：<code className="bg-white/70 px-1 rounded">公园 -金属</code></p>
            <p>· 双引号精确短语：<code className="bg-white/70 px-1 rounded">"人民公园"</code></p>
            <p>· 限定字段：<code className="bg-white/70 px-1 rounded">名称:长椅 位置:滨江 评价:江景 备注:蛙鸣</code></p>
            <p>· 中文既支持两字词组，也支持单字命中，不区分英文大小写</p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-2">
            <select
              value={materialFilter || ''}
              onChange={(e) => setMaterialFilter(e.target.value as MaterialType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部材质</option>
              {Object.entries(MATERIAL_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <select
              value={shadeFilter || ''}
              onChange={(e) => setShadeFilter(e.target.value as ShadeLevelType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部遮阴</option>
              {Object.entries(SHADE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <select
              value={noiseFilter || ''}
              onChange={(e) => setNoiseFilter(e.target.value as NoiseLevelType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部噪音</option>
              {Object.entries(NOISE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>

            <select
              value={orientationFilter || ''}
              onChange={(e) => setOrientationFilter(e.target.value as OrientationType || null)}
              className="px-3 py-1.5 text-sm bg-white/50 border border-deep-brown/10 rounded-lg text-deep-brown focus:bg-white cursor-pointer"
            >
              <option value="">全部朝向</option>
              {Object.entries(ORIENTATION_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3 ml-auto">
            <span className="text-sm text-ink-light">
              共 <span className="font-medium text-deep-brown">{filteredCount}</span> 条记录
            </span>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="flex items-center gap-1 px-3 py-1.5 text-sm text-ochre hover:text-ochre-light hover:bg-ochre/5 rounded-lg transition-colors"
              >
                <X className="w-3.5 h-3.5" />
                清除筛选
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
