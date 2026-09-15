import { create } from 'zustand';
import type { Bench, BenchExperience, MaterialType, OrientationType, ShadeLevelType, NoiseLevelType } from '@/types';
import { loadBenches, saveBenches } from '@/utils/storage';
import { generateId } from '@/utils/comfort';
import { mockBenches } from '@/data/mockBenches';
import { searchEngine, type SearchResult, type FieldSnippet } from '@/utils/search';

interface BenchState {
  benches: Bench[];
  searchQuery: string;
  materialFilter: MaterialType | null;
  orientationFilter: OrientationType | null;
  shadeFilter: ShadeLevelType | null;
  noiseFilter: NoiseLevelType | null;
  initialized: boolean;
  /** 检索引擎提示（索引损坏后已自动重建等），消费一次后清除 */
  searchNotice: string | null;
}

interface BenchActions {
  initialize: () => void;
  setSearchQuery: (query: string) => void;
  setMaterialFilter: (material: MaterialType | null) => void;
  setOrientationFilter: (orientation: OrientationType | null) => void;
  setShadeFilter: (shade: ShadeLevelType | null) => void;
  setNoiseFilter: (noise: NoiseLevelType | null) => void;
  clearFilters: () => void;
  addBench: (bench: Omit<Bench, 'id' | 'createdAt' | 'updatedAt' | 'experiences'>) => string;
  updateBench: (id: string, updates: Partial<Bench>) => void;
  deleteBench: (id: string) => void;
  getBenchById: (id: string) => Bench | undefined;
  addExperience: (benchId: string, experience: Omit<BenchExperience, 'id' | 'benchId'>) => void;
  updateExperience: (benchId: string, expId: string, updates: Partial<BenchExperience>) => void;
  deleteExperience: (benchId: string, expId: string) => void;
  getFilteredBenches: () => Bench[];
  /** 全文检索 + 属性筛选：返回按相关度排序的档案与命中片段、错误信息 */
  searchBenches: () => SearchResult & { benches: Bench[]; snippetsById: Map<string, FieldSnippet[]> };
  clearSearchNotice: () => void;
}

const initialState: BenchState = {
  benches: [],
  searchQuery: '',
  materialFilter: null,
  orientationFilter: null,
  shadeFilter: null,
  noiseFilter: null,
  initialized: false,
  searchNotice: null,
};

function applyAttributeFilters(
  list: Bench[],
  filters: Pick<BenchState, 'materialFilter' | 'orientationFilter' | 'shadeFilter' | 'noiseFilter'>,
): Bench[] {
  const { materialFilter, orientationFilter, shadeFilter, noiseFilter } = filters;
  return list.filter((bench) => {
    if (materialFilter && bench.material !== materialFilter) return false;
    if (orientationFilter && bench.orientation !== orientationFilter) return false;
    if (shadeFilter && bench.shadeLevel !== shadeFilter) return false;
    if (noiseFilter && bench.noiseLevel !== noiseFilter) return false;
    return true;
  });
}

export const useBenchStore = create<BenchState & BenchActions>((set, get) => ({
  ...initialState,

  initialize: () => {
    if (get().initialized) return;
    const stored = loadBenches();
    const benches = stored.length > 0 ? stored : mockBenches;
    if (stored.length === 0) saveBenches(mockBenches);

    // 检索索引以档案数据为准对账：缺失补齐、多余删除、内容变更增量更新；
    // 若 localStorage 中的索引损坏，引擎会自动清空并在这里完整重建
    const notice = searchEngine.notice;
    searchEngine.notice = null;
    searchEngine.reconcile(benches);
    searchEngine.flush();

    set({ benches, initialized: true, searchNotice: notice });
  },

  setSearchQuery: (query) => set({ searchQuery: query }),
  setMaterialFilter: (material) => set({ materialFilter: material }),
  setOrientationFilter: (orientation) => set({ orientationFilter: orientation }),
  setShadeFilter: (shade) => set({ shadeFilter: shade }),
  setNoiseFilter: (noise) => set({ noiseFilter: noise }),

  clearFilters: () => set({
    searchQuery: '',
    materialFilter: null,
    orientationFilter: null,
    shadeFilter: null,
    noiseFilter: null,
  }),

  clearSearchNotice: () => set({ searchNotice: null }),

  addBench: (benchData) => {
    const now = new Date().toISOString();
    const newBench: Bench = {
      ...benchData,
      id: generateId(),
      experiences: [],
      createdAt: now,
      updatedAt: now,
    };
    const newBenches = [newBench, ...get().benches];
    set({ benches: newBenches });
    saveBenches(newBenches);
    searchEngine.upsert(newBench);
    searchEngine.flush();
    return newBench.id;
  },

  updateBench: (id, updates) => {
    const newBenches = get().benches.map((bench) =>
      bench.id === id
        ? { ...bench, ...updates, updatedAt: new Date().toISOString() }
        : bench
    );
    set({ benches: newBenches });
    saveBenches(newBenches);
    const updated = newBenches.find((b) => b.id === id);
    if (updated) searchEngine.upsert(updated);
  },

  deleteBench: (id) => {
    const newBenches = get().benches.filter((bench) => bench.id !== id);
    set({ benches: newBenches });
    saveBenches(newBenches);
    searchEngine.remove(id);
  },

  getBenchById: (id) => {
    return get().benches.find((bench) => bench.id === id);
  },

  addExperience: (benchId, experienceData) => {
    const newExperience: BenchExperience = {
      ...experienceData,
      id: generateId(),
      benchId,
    };
    const newBenches = get().benches.map((bench) =>
      bench.id === benchId
        ? {
            ...bench,
            experiences: [...bench.experiences, newExperience],
            updatedAt: new Date().toISOString(),
          }
        : bench
    );
    set({ benches: newBenches });
    saveBenches(newBenches);
    const updated = newBenches.find((b) => b.id === benchId);
    if (updated) searchEngine.upsert(updated);
  },

  updateExperience: (benchId, expId, updates) => {
    const newBenches = get().benches.map((bench) =>
      bench.id === benchId
        ? {
            ...bench,
            experiences: bench.experiences.map((exp) =>
              exp.id === expId ? { ...exp, ...updates } : exp
            ),
            updatedAt: new Date().toISOString(),
          }
        : bench
    );
    set({ benches: newBenches });
    saveBenches(newBenches);
    const updated = newBenches.find((b) => b.id === benchId);
    if (updated) searchEngine.upsert(updated);
  },

  deleteExperience: (benchId, expId) => {
    const newBenches = get().benches.map((bench) =>
      bench.id === benchId
        ? {
            ...bench,
            experiences: bench.experiences.filter((exp) => exp.id !== expId),
            updatedAt: new Date().toISOString(),
          }
        : bench
    );
    set({ benches: newBenches });
    saveBenches(newBenches);
    const updated = newBenches.find((b) => b.id === benchId);
    if (updated) searchEngine.upsert(updated);
  },

  getFilteredBenches: () => {
    const state = get();
    return applyAttributeFilters(state.benches, state);
  },

  searchBenches: () => {
    const state = get();
    const query = state.searchQuery.trim();

    if (!query) {
      const benches = applyAttributeFilters(state.benches, state);
      return {
        ok: true as const,
        hits: [],
        benches,
        snippetsById: new Map(),
        positiveCount: 0,
        negativeCount: 0,
      };
    }

    const result = searchEngine.search(state.searchQuery);
    if (!result.ok) {
      return { ...result, benches: [], snippetsById: new Map() };
    }

    const byId = new Map(state.benches.map((b) => [b.id, b]));
    const snippetsById = new Map<string, FieldSnippet[]>();
    const matched: Bench[] = [];
    for (const hit of result.hits) {
      const bench = byId.get(hit.benchId);
      if (!bench) continue;
      snippetsById.set(hit.benchId, hit.snippets);
      matched.push(bench);
    }
    const benches = applyAttributeFilters(matched, state);
    return { ...result, benches, snippetsById };
  },
}));
