const HEADER_LIMIT = 1024 * 1024;

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_HEADS" });
}

export function readSafetensors(buffer) {
  if (buffer.length < 8) throw invalid("safetensors file is truncated");
  const headerLength = Number(buffer.readBigUInt64LE(0));
  if (headerLength <= 0 || headerLength > HEADER_LIMIT || 8 + headerLength > buffer.length) {
    throw invalid("safetensors header is invalid");
  }
  const header = JSON.parse(buffer.subarray(8, 8 + headerLength).toString("utf8"));
  const base = 8 + headerLength;
  const tensors = {};
  for (const [name, spec] of Object.entries(header)) {
    if (name === "__metadata__") continue;
    if (spec.dtype !== "F32") throw invalid(`${name} is ${spec.dtype}, expected F32`);
    const [begin, end] = spec.data_offsets;
    const count = spec.shape.reduce((acc, dim) => acc * dim, 1);
    if (end - begin !== count * 4 || base + end > buffer.length) throw invalid(`${name} has a wrong size`);
    const values = new Float32Array(count);
    for (let i = 0; i < count; i++) values[i] = buffer.readFloatLE(base + begin + i * 4);
    tensors[name] = { shape: spec.shape, values };
  }
  return tensors;
}

export function tokenHead(tensors, labels, hidden) {
  const weight = tensors["token_cls_head.weight"];
  const bias = tensors["token_cls_head.bias"];
  if (!weight || !bias) throw invalid("token_cls_head is missing");
  if (weight.shape[0] !== labels || weight.shape[1] !== hidden || bias.shape[0] !== labels) {
    throw invalid(`token_cls_head must be ${labels}x${hidden}`);
  }
  return { weight: weight.values, bias: bias.values, labels, hidden };
}

export function tokenLogits(head, states) {
  const { weight, bias, labels, hidden } = head;
  const out = new Array(states.length);
  for (let t = 0; t < states.length; t++) {
    const h = states[t];
    if (!Array.isArray(h) || h.length !== hidden) throw invalid(`hidden state ${t} has ${h?.length ?? 0} values, expected ${hidden}`);
    const row = new Float64Array(labels);
    for (let c = 0; c < labels; c++) {
      let sum = bias[c];
      const offset = c * hidden;
      for (let k = 0; k < hidden; k++) sum += weight[offset + k] * h[k];
      row[c] = sum;
    }
    out[t] = row;
  }
  return out;
}
