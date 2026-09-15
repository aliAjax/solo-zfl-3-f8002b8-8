import type { Bench } from '@/types';

/**
 * 本地全文检索引擎
 *
 * - 中文按单字（unigram）+ 两字词组（bigram）建倒排索引，兼顾词组命中与单字命中
 * - 拉丁/数字按词建索引
 * - 支持多词 与(空格 / 且 / AND)、或(OR / 或 / | / ,)、非(- / NOT / 非)
 * - 双引号短语、字段限定（名称: / 位置: / 评价: / 备注: 及英文别名）
 * - TF-IDF 字段权重相关度排序，同分按固定次序稳定排列
 * - 增删改增量更新，索引持久化到 localStorage，损坏自动重建并提示
 */

export type SearchField = 'name' | 'location' | 'review' | 'notes';

export const FIELD_LABELS: Record<SearchField, string> = {
  name: '名称',
  location: '位置',
  review: '评价',
  notes: '备注',
};

const FIELD_ALIASES: Record<string, SearchField> = {
  name: 'name',
  location: 'location',
  review: 'review',
  notes: 'notes',
  名称: 'name',
  名字: 'name',
  标题: 'name',
  位置: 'location',
  地点: 'location',
  地址: 'location',
  评价: 'review',
  评论: 'review',
  备注: 'notes',
  体验: 'notes',
  时段: 'notes',
  笔记: 'notes',
};

// 字段权重：名称 > 位置 > 评价 > 分时段备注
const FIELD_BOOST: Record<SearchField, number> = {
  name: 4,
  location: 2.5,
  review: 1.5,
  notes: 1,
};

// bigram 命中权重高于单字，使两字词组排在单字命中之前
const BIGRAM_WEIGHT = 2;
const UNIGRAM_WEIGHT = 1;
// 短语连续命中额外加权
const PHRASE_BONUS = 1.5;

const INDEX_KEY = 'bench-archive-search-index-v1';
const INDEX_VERSION = 1;
const PERSIST_DELAY_MS = 400;

export interface SearchError {
  code: 'EMPTY' | 'EMPTY_QUERY' | 'UNTERMINATED_QUOTE' | 'NO_POSITIVE' | 'UNKNOWN_FIELD' | 'EMPTY_TERM';
  message: string;
  /** 触发错误的原始片段（如未闭合的引号内容），用于提示 */
  token?: string;
}

export interface HighlightSegment {
  text: string;
  match: boolean;
}

export interface FieldSnippet {
  field: SearchField;
  label: string;
  segments: HighlightSegment[];
}

export interface SearchHit {
  benchId: string;
  score: number;
  snippets: FieldSnippet[];
}

export interface SearchResult {
  ok: boolean;
  error?: SearchError;
  hits: SearchHit[];
  /** 解析后参与匹配的正/负原子数，供 UI 展示查询概况 */
  positiveCount: number;
  negativeCount: number;
}

/* ------------------------------------------------------------------ */
/* 分词                                                                */
/* ------------------------------------------------------------------ */

function isCJK(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK 统一表意文字
    (code >= 0x3400 && code <= 0x4dbf) ||   // 扩展 A
    (code >= 0x20000 && code <= 0x2a6df) || // 扩展 B
    (code >= 0xf900 && code <= 0xfaff)      // 兼容表意文字
  );
}

function isAlphaNum(ch: string): boolean {
  return /[a-z0-9]/.test(ch);
}

export interface Token {
  term: string;
  pos: number; // 在归一化文本中的起始下标
  bigram: boolean;
}

/**
 * 文本分词：
 * - CJK 连续段：每个单字一个 unigram，相邻两字一个 bigram（词组命中）
 * - 拉丁/数字连续段：整段作为一个词（小写）
 */
export function tokenize(text: string): Token[] {
  const lower = text.toLowerCase();
  const tokens: Token[] = [];
  let i = 0;
  const len = lower.length;

  while (i < len) {
    const ch = lower[i];
    if (isCJK(ch)) {
      let j = i;
      const run: number[] = [];
      while (j < len && isCJK(lower[j])) {
        run.push(j);
        j++;
      }
      for (let k = 0; k < run.length; k++) {
        tokens.push({ term: lower[run[k]], pos: run[k], bigram: false });
        if (k + 1 < run.length) {
          tokens.push({
            term: lower.slice(run[k], run[k + 1] + 1),
            pos: run[k],
            bigram: true,
          });
        }
      }
      i = j;
    } else if (isAlphaNum(ch)) {
      let j = i;
      while (j < len && isAlphaNum(lower[j])) j++;
      tokens.push({ term: lower.slice(i, j), pos: i, bigram: false });
      i = j;
    } else {
      i++;
    }
  }
  return tokens;
}

/** 归一化用于短语连续匹配的文本：小写、折叠空白，并去掉与中文相邻的空格（分词本就忽略它） */
export function normalizePhraseText(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[ \t\u3000]+/g, ' ')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
  // 反复消去中文与空格的交界，如 “人民 公园” -> “人民公园”，“abc 公园x” -> “abc公园x”
  for (;;) {
    const next = s.replace(/([\u3400-\u9fff\uf900-\ufaff])\s+|\s+(?=[\u3400-\u9fff\uf900-\ufaff])/g, '$1');
    if (next === s) return s;
    s = next;
  }
}

/* ------------------------------------------------------------------ */
/* 查询语法解析                                                        */
/* ------------------------------------------------------------------ */

interface QueryAtom {
  /** phrase: 双引号短语，按连续子串匹配；word: 普通词 */
  kind: 'phrase' | 'word';
  /** word 时为分词后的 term 集合；phrase 时为短语的分词集合（全部需连续出现） */
  terms: string[];
  raw: string;
  field: SearchField | null;
  negated: boolean;
}

interface QueryGroup {
  atoms: QueryAtom[];
  /** 组内 OR 关系；组之间 AND 关系（DNF） */
  or: boolean;
}

export interface ParsedQuery {
  groups: QueryGroup[];
  positive: QueryAtom[];
  negative: QueryAtom[];
}

const OR_WORDS = new Set(['or', 'OR', '|', '||', '或', '或者', ',', '，']);

/**
 * 词法扫描：把查询字符串切成 token
 * 支持 "短语"、字段前缀（名称:xxx）、-非、+与
 */
interface RawToken {
  text: string;
  quoted: boolean;
  negated: boolean;
}

function scanTokens(input: string): RawToken[] {
  const tokens: RawToken[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    while (i < len && /\s/.test(input[i])) i++;
    if (i >= len) break;

    let negated = false;
    // 前导 - 表示非（-- 也视作非）
    while (i < len && (input[i] === '-' || input[i] === '−')) {
      negated = !negated;
      i++;
    }
    while (i < len && input[i] === '+') i++;
    while (i < len && /\s/.test(input[i])) i++;
    if (i >= len) break;

    if (input[i] === '"' || input[i] === '“' || input[i] === '”') {
      // 双引号短语
      const start = i + 1;
      let j = start;
      let closed = false;
      let buf = '';
      while (j < len) {
        const c = input[j];
        if (c === '"' || c === '”') {
          closed = true;
          break;
        }
        if (c === '\\' && j + 1 < len) {
          buf += input[j + 1];
          j += 2;
          continue;
        }
        buf += c;
        j++;
      }
      if (!closed) {
        // 用一个特殊对象报告未闭合：这里抛出由 parseQuery 捕获
        const error = new Error('UNTERMINATED_QUOTE') as Error & { code: string; token: string };
        error.code = 'UNTERMINATED_QUOTE';
        error.token = input.slice(start);
        throw error;
      }
      tokens.push({ text: buf, quoted: true, negated });
      i = j + 1;
    } else {
      // 普通 token（直到空白；标点附着在词上由后续逻辑处理）
      let j = i;
      let buf = '';
      let containsQuote = false;
      while (j < len && !/\s/.test(input[j])) {
        const c = input[j];
        if (c === '"' || c === '“') {
          // 词中出现引号：短语拼接进当前 token，如 名称:"人民公园"
          containsQuote = true;
          const start = j + 1;
          let k = start;
          let inner = '';
          let closed = false;
          while (k < len) {
            const qc = input[k];
            if (qc === '"' || qc === '”') {
              closed = true;
              break;
            }
            if (qc === '\\' && k + 1 < len) {
              inner += input[k + 1];
              k += 2;
              continue;
            }
            inner += qc;
            k++;
          }
          if (!closed) {
            const error = new Error('UNTERMINATED_QUOTE') as Error & { code: string; token: string };
            error.code = 'UNTERMINATED_QUOTE';
            error.token = input.slice(start);
            throw error;
          }
          buf += inner;
          j = k + 1;
          continue;
        }
        buf += c;
        j++;
      }
      if (buf.length > 0) tokens.push({ text: buf, quoted: containsQuote, negated });
      i = j;
    }
  }
  return tokens;
}

export function parseQuery(input: string): ParsedQuery | SearchError {
  const trimmed = input.trim();
  if (!trimmed) {
    return { code: 'EMPTY', message: '请输入搜索关键词' };
  }

  let rawTokens: RawToken[];
  try {
    rawTokens = scanTokens(input);
  } catch (e) {
    const err = e as Error & { code?: string; token?: string };
    if (err.code === 'UNTERMINATED_QUOTE') {
      return {
        code: 'UNTERMINATED_QUOTE',
        message: '引号没有闭合，请补上结尾的双引号（"）',
        token: err.token,
      };
    }
    throw e;
  }

  const groups: QueryGroup[] = [];
  const positive: QueryAtom[] = [];
  const negative: QueryAtom[] = [];

  // 展开词内 OR 分隔符：公园,长椅 / 公园|长椅（引号短语不拆）
  interface ExpandedToken { rt: RawToken; orBefore: boolean }
  const expanded: ExpandedToken[] = [];
  for (const rt of rawTokens) {
    if (rt.quoted) {
      expanded.push({ rt, orBefore: false });
      continue;
    }
    const parts = rt.text.split(/[,，|]+/).filter((p) => p.length > 0);
    parts.forEach((p, i) => {
      expanded.push({ rt: { ...rt, text: p }, orBefore: i > 0 });
    });
  }

  // OR 分组缓冲：A OR B OR C 同组；遇到 AND 边界封存为一组
  let buffer: QueryAtom[] = [];
  let pendingOr = false;
  let sawAny = false;

  const flushGroup = () => {
    if (buffer.length > 0) {
      groups.push({ atoms: buffer, or: buffer.length > 1 });
      buffer = [];
    }
    pendingOr = false;
  };

  for (let t = 0; t < expanded.length; t++) {
    const { rt, orBefore } = expanded[t];

    if (OR_WORDS.has(rt.text)) {
      // 仅当上一个原子存在时 OR 才生效；开头/连续的 OR 忽略
      if (sawAny) pendingOr = true;
      continue;
    }
    if (orBefore && sawAny) pendingOr = true;
    // 自然语言连接词：空格本身即 AND，直接忽略
    if (rt.text === '与' || rt.text === '且' || rt.text === '和' || rt.text.toLowerCase() === 'and') {
      continue;
    }

    let text = rt.text;
    const negated = rt.negated;
    let field: SearchField | null = null;

    // NOT 关键字：not xxx / 非 xxx（作用于下一个 token）
    if (!rt.quoted && (text.toLowerCase() === 'not' || text === '非')) {
      const next = expanded[t + 1]?.rt;
      if (next) next.negated = true;
      continue;
    }

    // 字段前缀：名称:xxx / location:xxx（引号短语已在扫描时并入文本）
    const fieldMatch = /^([A-Za-z]{2,}|[\u3400-\u9fff\uf900-\ufaff]{1,2})[:：]/.exec(text);
    if (fieldMatch) {
      const rawName = fieldMatch[1];
      const key = /[A-Za-z]/.test(rawName[0]) ? rawName.toLowerCase() : rawName;
      const mapped = FIELD_ALIASES[key];
      if (!mapped) {
        return {
          code: 'UNKNOWN_FIELD',
          message: `不认识的字段“${rawName}”，可用字段：名称、位置、评价、备注`,
          token: rawName,
        };
      }
      field = mapped;
      text = text.slice(fieldMatch[0].length);
    }

    // 去掉句尾附着的标点
    text = text.replace(/[。、；！？!?]+$/u, '');

    if (!text) {
      return {
        code: 'EMPTY_TERM',
        message: '字段限定后缺少搜索内容，例如“名称:长椅”',
        token: rt.text,
      };
    }

    const isPhrase = rt.quoted;
    const phraseNorm = normalizePhraseText(text);
    const termSet = new Set<string>();
    for (const tk of tokenize(isPhrase ? phraseNorm : text)) termSet.add(tk.term);

    if (termSet.size === 0) {
      return {
        code: 'EMPTY_TERM',
        message: `“${rt.text}”里没有可搜索的字词，请输入中文、字母或数字`,
        token: rt.text,
      };
    }

    const atom: QueryAtom = {
      kind: isPhrase ? 'phrase' : 'word',
      terms: [...termSet],
      raw: isPhrase ? phraseNorm : text.toLowerCase(),
      field,
      negated,
    };

    if (negated) {
      // “非”是全局排除，不参与 OR，作为 AND 边界
      flushGroup();
      negative.push(atom);
      sawAny = true;
      continue;
    }

    // 正原子与前一组不是 OR 连接时，封存前一组（AND）
    if (sawAny && !pendingOr) flushGroup();
    buffer.push(atom);
    positive.push(atom);
    sawAny = true;
    pendingOr = false;
  }
  flushGroup();

  if (positive.length === 0) {
    if (negative.length > 0) {
      return {
        code: 'NO_POSITIVE',
        message: '不能只写要排除的词（“非”），请先给出至少一个要搜索的词',
      };
    }
    return { code: 'EMPTY_TERM', message: '请输入有效的搜索关键词（中文、字母或数字）' };
  }

  return { groups, positive, negative };
}

/* ------------------------------------------------------------------ */
/* 倒排索引                                                            */
/* ------------------------------------------------------------------ */

interface FieldIndex {
  /** term -> 词频（同一 term 在该字段出现次数） */
  tf: Map<string, number>;
  /** 分词结果（用于短语位置判定） */
  tokens: Token[];
  /** 归一化原文（短语子串匹配 + 摘要） */
  normalized: string;
  /** 原始文本（摘要展示） */
  original: string;
  lengthTokens: number;
}

interface DocEntry {
  id: string;
  seq: number;
  fields: Record<SearchField, FieldIndex>;
}

interface SerializedIndex {
  version: number;
  seq: number;
  docs: Array<{
    i: string;
    s: number;
    f: Record<string, { tf: Record<string, number>; t: Token[]; n: string; o: string; l: number }>;
  }>;
}

function buildFieldIndex(original: string): FieldIndex {
  const normalized = normalizePhraseText(original);
  const tokens = tokenize(normalized);
  const tf = new Map<string, number>();
  for (const tk of tokens) {
    tf.set(tk.term, (tf.get(tk.term) ?? 0) + 1);
  }
  return {
    tf,
    tokens,
    normalized,
    original,
    lengthTokens: Math.max(1, tokens.length),
  };
}

function emptyFieldIndex(): FieldIndex {
  return { tf: new Map(), tokens: [], normalized: '', original: '', lengthTokens: 1 };
}

function benchFields(bench: Bench): Record<SearchField, string> {
  return {
    name: bench.name ?? '',
    location: bench.location ?? '',
    review: bench.review ?? '',
    notes: (bench.experiences ?? [])
      .map((e) => e.notes ?? '')
      .filter(Boolean)
      .join('  '),
  };
}

export class SearchEngine {
  private docs = new Map<string, DocEntry>();
  /** 倒排表：term -> field -> Set<docId> */
  private postings = new Map<string, Map<SearchField, Set<string>>>();
  private seq = 0;
  private order: string[] = [];
  private idfCache = new Map<string, number>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private storageBroken = false;
  /** 初始化/加载时的提示（索引损坏并已重建等） */
  notice: string | null = null;

  constructor() {
    this.load();
  }

  /* ---------------- 构建 / 增量更新 ---------------- */

  bulkAdd(benches: Bench[]): void {
    for (const bench of benches) this.upsert(bench, false);
    this.idfCache.clear();
    this.schedulePersist();
  }

  /** 增改一条记录：增量更新倒排表，不重建整个索引 */
  upsert(bench: Bench, persist = true): void {
    const existing = this.docs.get(bench.id);
    if (existing) this.removeFromPostings(bench.id);
    const texts = benchFields(bench);
    const fields = {
      name: buildFieldIndex(texts.name),
      location: buildFieldIndex(texts.location),
      review: buildFieldIndex(texts.review),
      notes: buildFieldIndex(texts.notes),
    };
    // 更新保留原序号，保证同分稳定排序不被编辑打乱；新增才分配序号
    const entry: DocEntry = {
      id: bench.id,
      seq: existing ? existing.seq : this.seq++,
      fields,
    };
    this.docs.set(bench.id, entry);
    if (!existing) this.order.push(bench.id);
    this.idfCache.clear();
    for (const fieldName of Object.keys(fields) as SearchField[]) {
      this.addToPostings(bench.id, fieldName, fields[fieldName]);
    }
    if (persist) this.schedulePersist();
  }

  remove(id: string): void {
    if (!this.docs.has(id)) return;
    this.removeFromPostings(id);
    this.docs.delete(id);
    const oi = this.order.indexOf(id);
    if (oi >= 0) this.order.splice(oi, 1);
    this.idfCache.clear();
    this.schedulePersist();
  }

  size(): number {
    return this.docs.size;
  }

  private addToPostings(docId: string, field: SearchField, fi: FieldIndex): void {
    for (const term of fi.tf.keys()) {
      let byField = this.postings.get(term);
      if (!byField) {
        byField = new Map();
        this.postings.set(term, byField);
      }
      let set = byField.get(field);
      if (!set) {
        set = new Set();
        byField.set(field, set);
      }
      set.add(docId);
    }
  }

  private removeFromPostings(docId: string): void {
    const entry = this.docs.get(docId);
    if (!entry) return;
    for (const [fieldName, fi] of Object.entries(entry.fields) as [SearchField, FieldIndex][]) {
      for (const term of fi.tf.keys()) {
        const byField = this.postings.get(term);
        if (!byField) continue;
        const set = byField.get(fieldName);
        if (set) {
          set.delete(docId);
          if (set.size === 0) {
            byField.delete(fieldName);
            if (byField.size === 0) this.postings.delete(term);
          }
        }
      }
    }
  }

  /* ---------------- 持久化 ---------------- */

  private load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(INDEX_KEY);
    } catch {
      this.storageBroken = true;
      return;
    }
    if (!raw) return;

    let data: SerializedIndex;
    try {
      data = JSON.parse(raw) as SerializedIndex;
    } catch {
      this.notice = '检索索引已损坏，已根据档案数据自动重建索引';
      try {
        localStorage.removeItem(INDEX_KEY);
      } catch {
        /* ignore */
      }
      return;
    }

    if (!data || data.version !== INDEX_VERSION || !Array.isArray(data.docs)) {
      this.notice = '检索索引版本不兼容，已自动重建';
      this.safeRemove();
      return;
    }

    try {
      this.hydrate(data);
    } catch {
      this.notice = '检索索引内容损坏，已根据档案数据自动重建索引';
      this.docs.clear();
      this.postings.clear();
      this.order = [];
      this.seq = 0;
      this.safeRemove();
    }
  }

  private hydrate(data: SerializedIndex): void {
    let maxSeq = 0;
    for (const d of data.docs) {
      if (!d || typeof d.i !== 'string' || !d.f || typeof d.f !== 'object') {
        throw new Error('bad doc');
      }
      const fields = {
        name: emptyFieldIndex(),
        location: emptyFieldIndex(),
        review: emptyFieldIndex(),
        notes: emptyFieldIndex(),
      } as Record<SearchField, FieldIndex>;
      for (const fk of Object.keys(d.f)) {
        if (!(fk in FIELD_BOOST)) throw new Error('bad field');
        const rawF = d.f[fk];
        if (!rawF || typeof rawF.n !== 'string' || typeof rawF.o !== 'string' || !rawF.tf || !Array.isArray(rawF.t)) {
          throw new Error('bad field data');
        }
        const fi: FieldIndex = {
          tf: new Map(Object.entries(rawF.tf)),
          tokens: rawF.t,
          normalized: rawF.n,
          original: rawF.o,
          lengthTokens: rawF.l || 1,
        };
        fields[fk as SearchField] = fi;
      }
      const entry: DocEntry = { id: d.i, seq: d.s, fields };
      this.docs.set(d.i, entry);
      this.order.push(d.i);
      for (const fieldName of Object.keys(fields) as SearchField[]) {
        this.addToPostings(d.i, fieldName, fields[fieldName]);
      }
      maxSeq = Math.max(maxSeq, d.s);
    }
    this.seq = typeof data.seq === 'number' ? data.seq : maxSeq + 1;
  }

  private safeRemove(): void {
    try {
      localStorage.removeItem(INDEX_KEY);
    } catch {
      /* ignore */
    }
  }

  private schedulePersist(): void {
    if (this.storageBroken) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.flush();
    }, PERSIST_DELAY_MS);
  }

  /** 立即把索引写入 localStorage（页面隐藏/关闭前调用） */
  flush(): void {
    if (this.storageBroken) return;
    try {
      const data: SerializedIndex = {
        version: INDEX_VERSION,
        seq: this.seq,
        docs: this.order.map((id) => {
          const entry = this.docs.get(id)!;
          const f: SerializedIndex['docs'][number]['f'] = {};
          for (const [fieldName, fi] of Object.entries(entry.fields) as [SearchField, FieldIndex][]) {
            f[fieldName] = {
              tf: Object.fromEntries(fi.tf),
              t: fi.tokens,
              n: fi.normalized,
              o: fi.original,
              l: fi.lengthTokens,
            };
          }
          return { i: entry.id, s: entry.seq, f };
        }),
      };
      localStorage.setItem(INDEX_KEY, JSON.stringify(data));
    } catch (e) {
      // 配额超限等：索引保留在内存中，本次会话检索仍可用
      this.storageBroken = true;
      console.warn('检索索引无法写入本地存储，本次会话仍可检索，但刷新后将重建：', e);
    }
  }

  /** 与档案数据对账：以档案为准，补齐缺失、删除多余（索引损坏/外部改动后的自愈） */
  reconcile(benches: Bench[]): void {
    const dataIds = new Set(benches.map((b) => b.id));
    let changed = false;
    for (const id of [...this.docs.keys()]) {
      if (!dataIds.has(id)) {
        this.remove(id);
        changed = true;
      }
    }
    const byId = new Map(benches.map((b) => [b.id, b]));
    for (const bench of benches) {
      const entry = this.docs.get(bench.id);
      const texts = benchFields(bench);
      const outOfDate =
        !entry ||
        (Object.keys(texts) as SearchField[]).some(
          (fk) => entry.fields[fk].original !== texts[fk]
        );
      if (outOfDate) {
        this.upsert(byId.get(bench.id)!, false);
        changed = true;
      }
    }
    // 顺序与档案一致，保证同分稳定排序的默认次序
    this.order = benches.map((b) => b.id);
    this.docs.forEach((entry, id) => {
      const idx = this.order.indexOf(id);
      if (idx >= 0) entry.seq = idx;
    });
    this.seq = this.order.length;
    if (changed || this.notice) this.schedulePersist();
  }

  /* ---------------- 检索 ---------------- */

  private idf(term: string): number {
    const cached = this.idfCache.get(term);
    if (cached !== undefined) return cached;
    const byField = this.postings.get(term);
    let df = 0;
    if (byField) {
      const seen = new Set<string>();
      for (const set of byField.values()) {
        for (const id of set) seen.add(id);
      }
      df = seen.size;
    }
    const n = Math.max(1, this.docs.size);
    const value = Math.log(1 + n / (df + 1));
    this.idfCache.set(term, value);
    return value;
  }

  /** 计算一个原子在某文档上的得分；0 表示不匹配 */
  private scoreAtom(atom: QueryAtom, entry: DocEntry): number {
    const fields = (atom.field ? [atom.field] : Object.keys(FIELD_BOOST)) as SearchField[];
    let best = 0;
    for (const fk of fields) {
      const fi = entry.fields[fk];
      const s = atom.kind === 'phrase'
        ? this.scorePhraseAtom(atom, fi, fk)
        : this.scoreWordAtom(atom, fi, fk);
      if (s > best) best = s;
    }
    return best;
  }

  /** 把原子的 term 拆成 bigram / 单字 / 拉丁词三类 */
  private classifyTerms(atom: QueryAtom): { bigrams: string[]; unigrams: string[]; words: string[] } {
    const bigrams: string[] = [];
    const unigrams: string[] = [];
    const words: string[] = [];
    for (const term of atom.terms) {
      if (term.length >= 2 && isCJK(term[0]) && isCJK(term[1] ?? '')) {
        bigrams.push(term);
      } else if (term.length === 1 && isCJK(term[0])) {
        unigrams.push(term);
      } else {
        words.push(term);
      }
    }
    return { bigrams, unigrams, words };
  }

  private termContrib(term: string, freq: number, fi: FieldIndex, fk: SearchField, weight: number): number {
    const tf = 1 + Math.log(freq);
    return weight * (tf / Math.sqrt(fi.lengthTokens)) * this.idf(term) * FIELD_BOOST[fk];
  }

  private scoreWordAtom(atom: QueryAtom, fi: FieldIndex, fk: SearchField): number {
    const { bigrams, unigrams, words } = this.classifyTerms(atom);

    const hitBigrams = bigrams.filter((t) => fi.tf.has(t));
    const hitUnigrams = unigrams.filter((t) => fi.tf.has(t));
    const hitWords = words.filter((t) => fi.tf.has(t));

    // 命中条件（按优先级）：
    // 1) 连续覆盖：所有两字词组都命中（查询词作为连续片段出现，最精确）
    // 2) 单字覆盖：所有单字 + 拉丁词都出现（容忍中间插字，如“人民的公园”命中“人民公园”）
    const allUni = unigrams.length === 0 || hitUnigrams.length === unigrams.length;
    const allWords = words.length === 0 || hitWords.length === words.length;
    const bigramCovered = bigrams.length > 0 && hitBigrams.length === bigrams.length;
    // 单字回退：至少一个两字词组锚定（或查询本身无 bigram），且全部单字/拉丁词出现
    // —— 容忍中间插字，如“人民公园”命中“人民的公园”
    const unigramFallback =
      allUni && allWords && (bigrams.length === 0 || hitBigrams.length > 0);
    if (!bigramCovered && !unigramFallback) return 0;

    const viaBigram = bigramCovered;
    let s = 0;
    for (const t of hitBigrams) {
      s += this.termContrib(t, fi.tf.get(t)!, fi, fk, BIGRAM_WEIGHT);
    }
    const uniWeight = viaBigram ? 0.3 : 0.6;
    for (const t of hitUnigrams) {
      s += this.termContrib(t, fi.tf.get(t)!, fi, fk, uniWeight);
    }
    for (const t of hitWords) {
      s += this.termContrib(t, fi.tf.get(t)!, fi, fk, BIGRAM_WEIGHT);
    }
    return s;
  }

  private scorePhraseAtom(atom: QueryAtom, fi: FieldIndex, fk: SearchField): number {
    const { bigrams, unigrams, words } = this.classifyTerms(atom);
    const hitBigrams = bigrams.filter((t) => fi.tf.has(t));
    const hitUnigrams = unigrams.filter((t) => fi.tf.has(t));
    const hitWords = words.filter((t) => fi.tf.has(t));

    // 短语：优先要求归一化原文连续包含整个短语
    const continuous = atom.raw.length > 0 && fi.normalized.includes(atom.raw);
    if (!continuous) {
      // 容错：全部 bigram 命中，或全部单字 + 拉丁词命中
      const bigramOk = bigrams.length > 0 && hitBigrams.length === bigrams.length;
      const uniOk =
        hitUnigrams.length === unigrams.length && hitWords.length === words.length;
      if (!bigramOk && !uniOk) return 0;
    }

    let s = 0;
    for (const t of hitBigrams) s += this.termContrib(t, fi.tf.get(t)!, fi, fk, BIGRAM_WEIGHT);
    for (const t of hitUnigrams) s += this.termContrib(t, fi.tf.get(t)!, fi, fk, UNIGRAM_WEIGHT);
    for (const t of hitWords) s += this.termContrib(t, fi.tf.get(t)!, fi, fk, BIGRAM_WEIGHT);
    return s * (continuous ? PHRASE_BONUS : PHRASE_BONUS * 0.8);
  }

  search(query: string): SearchResult {
    const parsed = parseQuery(query);
    if ('code' in parsed) {
      return { ok: false, error: parsed, hits: [], positiveCount: 0, negativeCount: 0 };
    }

    // 负向原子命中的文档全部排除
    const excluded = new Set<string>();
    for (const atom of parsed.negative) {
      for (const entry of this.docs.values()) {
        if (this.scoreAtom(atom, entry) > 0) excluded.add(entry.id);
      }
    }

    const scores = new Map<string, number>();

    // 组之间 AND：每组都需命中；组内 OR：取组内最高分
    for (let gi = 0; gi < parsed.groups.length; gi++) {
      const group = parsed.groups[gi];
      const groupScore = new Map<string, number>();

      for (const atom of group.atoms) {
        const candidates = this.candidateDocs(atom);
        for (const id of candidates) {
          if (excluded.has(id)) continue;
          // 第一组之后：只有前面组已命中的文档才算候选
          if (gi > 0 && !scores.has(id)) continue;
          const entry = this.docs.get(id);
          if (!entry) continue;
          const s = this.scoreAtom(atom, entry);
          if (s > 0) {
            groupScore.set(id, Math.max(groupScore.get(id) ?? 0, s));
          }
        }
      }

      if (gi === 0) {
        for (const [id, s] of groupScore) scores.set(id, s);
      } else {
        // 交集：删除未命中本组的文档，命中则累加组得分
        for (const id of [...scores.keys()]) {
          const s = groupScore.get(id);
          if (s === undefined) scores.delete(id);
          else scores.set(id, scores.get(id)! + s);
        }
      }
    }

    const hits: SearchHit[] = [];
    for (const [id, score] of scores) {
      if (score <= 0) continue;
      const entry = this.docs.get(id)!;
      hits.push({
        benchId: id,
        score,
        snippets: this.buildSnippets(entry, parsed.positive),
      });
    }

    // 相关度降序；同分按入库序号（≈档案顺序）稳定排列
    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const sa = this.docs.get(a.benchId)!.seq;
      const sb = this.docs.get(b.benchId)!.seq;
      return sa - sb;
    });

    return {
      ok: true,
      hits,
      positiveCount: parsed.positive.length,
      negativeCount: parsed.negative.length,
    };
  }

  private candidateDocs(atom: QueryAtom): Set<string> {
    const out = new Set<string>();
    const fields = (atom.field ? [atom.field] : Object.keys(FIELD_BOOST)) as SearchField[];
    for (const term of atom.terms) {
      const byField = this.postings.get(term);
      if (!byField) continue;
      for (const fk of fields) {
        const set = byField.get(fk);
        if (set) for (const id of set) out.add(id);
      }
    }
    return out;
  }

  /* ---------------- 摘要与高亮 ---------------- */

  /** 原子用于高亮/摘要的匹配面：短语原文 + term 原文形态 */
  private atomSurfaces(atom: QueryAtom): string[] {
    const surfaces = new Set<string>();
    if (atom.kind === 'phrase' && atom.raw) surfaces.add(atom.raw);
    for (const term of atom.terms) {
      if (term.length >= 1) surfaces.add(term);
    }
    surfaces.delete('');
    return [...surfaces];
  }

  private buildSnippets(entry: DocEntry, positive: QueryAtom[]): FieldSnippet[] {
    const byField = new Map<SearchField, QueryAtom[]>();
    for (const atom of positive) {
      const fields = (atom.field ? [atom.field] : Object.keys(FIELD_BOOST)) as SearchField[];
      for (const fk of fields) {
        if (entry.fields[fk].normalized) {
          const list = byField.get(fk) ?? [];
          list.push(atom);
          byField.set(fk, list);
        }
      }
    }

    const fieldOrder: SearchField[] = ['name', 'location', 'review', 'notes'];
    const snippets: FieldSnippet[] = [];
    for (const fk of fieldOrder) {
      const atoms = byField.get(fk);
      if (!atoms) continue;
      const fi = entry.fields[fk];
      const surfaces = atoms.flatMap((a) => this.atomSurfaces(a));
      const segments = this.makeSegments(fi.original, surfaces, fk === 'name' || fk === 'location' ? 48 : 72);
      if (segments.some((seg) => seg.match)) {
        snippets.push({ field: fk, label: FIELD_LABELS[fk], segments });
      }
      if (snippets.length >= 3) break;
    }
    return snippets;
  }

  /**
   * 在原文上找所有命中区间，合并后取最密集的窗口生成片段。
   * 匹配同时在原文与归一化文本上尝试（归一化偏移映射回原文）。
   */
  private makeSegments(original: string, surfaces: string[], maxLen: number): HighlightSegment[] {
    if (!original) return [];
    const lower = original.toLowerCase();
    const ranges: Array<[number, number]> = [];

    for (const surface of surfaces) {
      if (!surface) continue;
      let idx = lower.indexOf(surface);
      while (idx >= 0) {
        ranges.push([idx, idx + surface.length]);
        idx = lower.indexOf(surface, idx + Math.max(1, surface.length));
      }
    }

    if (ranges.length === 0) return [{ text: original, match: false }];

    ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged: Array<[number, number]> = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r[0] <= last[1]) {
        last[1] = Math.max(last[1], r[1]);
      } else {
        merged.push([...r] as [number, number]);
      }
    }

    // 选窗口：覆盖最多命中区间、长度不超过 maxLen
    let bestStart = 0;
    let bestCount = 0;
    const desiredStart = Math.max(0, merged[0][0] - 12);
    if (original.length <= maxLen) {
      bestStart = 0;
    } else {
      for (let i = 0; i < merged.length; i++) {
        const start = Math.max(0, Math.min(merged[i][0] - 12, original.length - maxLen));
        const end = start + maxLen;
        let count = 0;
        for (const r of merged) if (r[0] >= start && r[1] <= end) count++;
        if (count > bestCount) {
          bestCount = count;
          bestStart = start;
        }
      }
      if (bestCount === 0) bestStart = desiredStart;
    }

    const start = original.length <= maxLen ? 0 : bestStart;
    const end = Math.min(original.length, start + maxLen);
    const visible = merged.filter((r) => r[1] > start && r[0] < end);

    const segments: HighlightSegment[] = [];
    let cursor = start;
    for (const [r0, r1] of visible) {
      const s = Math.max(start, r0);
      const e = Math.min(end, r1);
      if (s > cursor) {
        segments.push({ text: original.slice(cursor, s), match: false });
      }
      segments.push({ text: original.slice(s, e), match: true });
      cursor = e;
    }
    if (cursor < end) segments.push({ text: original.slice(cursor, end), match: false });

    if (start > 0) segments.unshift({ text: '…', match: false });
    if (end < original.length) segments.push({ text: '…', match: false });
    return segments;
  }
}

/* ------------------------------------------------------------------ */
/* 单例 + 页面卸载前落盘                                                */
/* ------------------------------------------------------------------ */

export const searchEngine = new SearchEngine();

if (typeof window !== 'undefined') {
  const flush = () => searchEngine.flush();
  window.addEventListener('pagehide', flush);
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
}
