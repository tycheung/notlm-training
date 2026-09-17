/**
 * Minimal ONNX ModelProto for intent Gemm+Softmax.
 * Field numbers follow onnx.proto (ModelProto / GraphProto / NodeProto / TensorProto).
 * Owned by training — operating @uipilot/ranker only loads prebuilt bytes.
 */
import type { RankerModelJson } from '@uipilot/ranker';

function encodeVarint(n: number): number[] {
  const out: number[] = [];
  let v = n >>> 0;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return out;
}

function tag(field: number, wire: number): number[] {
  return encodeVarint((field << 3) | wire);
}

function lenDelim(field: number, payload: number[]): number[] {
  return [...tag(field, 2), ...encodeVarint(payload.length), ...payload];
}

function str(field: number, s: string): number[] {
  return lenDelim(field, [...new TextEncoder().encode(s)]);
}

function int64(field: number, n: number): number[] {
  return [...tag(field, 0), ...encodeVarint(n)];
}

function float32le(field: number, value: number): number[] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  return [...tag(field, 5), ...new Uint8Array(buf)];
}

function floatsRaw(values: number[]): number[] {
  const buf = new ArrayBuffer(values.length * 4);
  const view = new DataView(buf);
  for (let i = 0; i < values.length; i += 1) view.setFloat32(i * 4, values[i]!, true);
  return [...new Uint8Array(buf)];
}

function tensor(name: string, dims: number[], data: number[]): number[] {
  const body: number[] = [...str(1, name)];
  for (const d of dims) body.push(...int64(2, d));
  body.push(...int64(3, 1)); // FLOAT
  body.push(...lenDelim(7, floatsRaw(data)));
  return body;
}

function dimValue(v: number): number[] {
  return int64(1, v);
}

function valueInfo(name: string, dims: number[]): number[] {
  const shapeDims: number[] = [];
  for (const d of dims) shapeDims.push(...lenDelim(1, dimValue(d)));
  const tensorType = [...int64(1, 1), ...lenDelim(2, shapeDims)];
  const typeProto = lenDelim(1, tensorType);
  return [...str(1, name), ...lenDelim(2, typeProto)];
}

function attrInt(name: string, value: number): number[] {
  return [...str(1, name), ...int64(3, value), ...int64(20, 2)];
}

function attrFloat(name: string, value: number): number[] {
  return [...str(1, name), ...float32le(4, value), ...int64(20, 1)];
}

function node(
  opType: string,
  inputs: string[],
  outputs: string[],
  name: string,
  attrs: number[][]
): number[] {
  const body: number[] = [];
  for (const i of inputs) body.push(...str(1, i));
  for (const o of outputs) body.push(...str(2, o));
  body.push(...str(3, name));
  body.push(...str(4, opType));
  for (const a of attrs) body.push(...lenDelim(5, a));
  return body;
}

/** Export intent head as ONNX bytes (slot head remains JSON-only). */
export function exportIntentOnnx(model: RankerModelJson): Uint8Array {
  const C = model.intentLabels.length;
  const D = model.dim;
  const W = new Array<number>(D * C);
  for (let c = 0; c < C; c += 1) {
    for (let d = 0; d < D; d += 1) {
      W[d * C + c] = model.intentW[c * D + d] ?? 0;
    }
  }

  const gemm = node(
    'Gemm',
    ['X', 'W', 'B'],
    ['logits'],
    'intent_gemm',
    [attrFloat('alpha', 1), attrFloat('beta', 1)]
  );
  const soft = node('Softmax', ['logits'], ['probs'], 'intent_softmax', [
    attrInt('axis', 1),
  ]);

  const graph: number[] = [
    ...str(2, 'uipilot_intent_ranker'),
    ...lenDelim(1, gemm),
    ...lenDelim(1, soft),
    ...lenDelim(11, valueInfo('X', [1, D])),
    ...lenDelim(7, valueInfo('probs', [1, C])),
    ...lenDelim(5, tensor('W', [D, C], W)),
    ...lenDelim(5, tensor('B', [C], model.intentB)),
  ];

  const opset = [...str(1, ''), ...int64(2, 13)];
  const modelProto = [
    ...int64(1, 8),
    ...lenDelim(8, opset),
    ...str(2, 'uipilot'),
    ...lenDelim(7, graph),
  ];
  return new Uint8Array(modelProto);
}
