import type { Item, QueueItem, ShadowRecord } from "./types.js";
import { bigrams, jaccard } from "./linter.js";

export interface MapNode {
  id: string;
  title: string;
  kind: string;
  scope: string;
  status: string;
  x: number;
  y: number;
  priority?: number;
}

export interface MapEdge {
  source: string;
  target: string;
  relation: "duplicate" | "related";
  score: number;
}

export interface MapData {
  nodes: MapNode[];
  edges: MapEdge[];
  generatedAt: string;
}

const DIMS = 24;
const MAX_EDGES = 300;

export function projectMap(input: {
  items: Item[];
  queue: QueueItem[];
  shadow: ShadowRecord[];
}): MapData {
  const entries: Array<{ id: string; title: string; text: string; kind: string; scope: string; status: string; priority?: number }> = [
    ...input.items.map((item) => ({
      id: item.id,
      title: item.title,
      text: item.text,
      kind: item.kind,
      scope: item.scope,
      status: item.status,
      priority: item.priority,
    })),
    ...input.queue.map((item) => ({
      id: item.id,
      title: item.title,
      text: item.text,
      kind: item.kind,
      scope: item.scope,
      status: "queue",
      priority: item.priority,
    })),
    ...input.shadow.map((record) => ({
      id: record.id,
      title: record.title,
      text: record.candidate,
      kind: record.kind,
      scope: record.scope,
      status: record.falsePositive ? "false_positive" : "shadow",
      priority: record.priority,
    })),
  ];

  if (entries.length === 0) return { nodes: [], edges: [], generatedAt: new Date().toISOString() };

  const vectors = entries.map((entry) => vectorOf(`${entry.title} ${entry.text}`));
  const coords = pca2(vectors);
  const nodes: MapNode[] = entries.map((entry, index) => ({
    ...entry,
    x: coords[index][0],
    y: coords[index][1],
  }));

  const edges: MapEdge[] = [];
  for (let i = 0; i < entries.length && edges.length < MAX_EDGES; i++) {
    for (let j = i + 1; j < entries.length && edges.length < MAX_EDGES; j++) {
      const score = jaccard(bigrams(`${entries[i].title} ${entries[i].text}`), bigrams(`${entries[j].title} ${entries[j].text}`));
      if (score >= 0.45) {
        edges.push({
          source: entries[i].id,
          target: entries[j].id,
          relation: score >= 0.75 ? "duplicate" : "related",
          score: Math.round(score * 1000) / 1000,
        });
      }
    }
  }
  return { nodes, edges, generatedAt: new Date().toISOString() };
}

function vectorOf(text: string): number[] {
  const vector = new Array<number>(DIMS).fill(0);
  for (const gram of bigrams(text)) {
    vector[hash(gram) % DIMS] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function pca2(vectors: number[][]): Array<[number, number]> {
  const count = vectors.length;
  if (count === 0) return [];
  if (count === 1) return [[0.5, 0.5]];
  const mean = new Array<number>(DIMS).fill(0);
  for (const vector of vectors) for (let d = 0; d < DIMS; d++) mean[d] += vector[d] / count;
  const centered = vectors.map((vector) => vector.map((value, d) => value - mean[d]));
  const first = powerIteration(centered);
  const second = powerIteration(
    centered.map((vector) => {
      const projection = dot(vector, first);
      return vector.map((value, d) => value - projection * first[d]);
    }),
  );
  const raw = centered.map((vector) => [dot(vector, first), dot(vector, second)] as [number, number]);
  return normalize(raw);
}

function powerIteration(vectors: number[][]): number[] {
  let vector = new Array<number>(DIMS).fill(1 / Math.sqrt(DIMS));
  for (let iteration = 0; iteration < 24; iteration++) {
    const next = new Array<number>(DIMS).fill(0);
    for (const row of vectors) {
      const projection = dot(row, vector);
      for (let d = 0; d < DIMS; d++) next[d] += projection * row[d];
    }
    const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
    if (norm < 1e-9) break;
    vector = next.map((value) => value / norm);
  }
  return vector;
}

function normalize(points: Array<[number, number]>): Array<[number, number]> {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return points.map((point, index) => {
    if (spanX === 1 && spanY === 1) {
      const angle = index * 2.399963;
      return [0.5 + Math.cos(angle) * 0.32, 0.5 + Math.sin(angle) * 0.32];
    }
    return [
      0.05 + ((point[0] - minX) / spanX) * 0.9,
      0.05 + ((point[1] - minY) / spanY) * 0.9,
    ];
  });
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
