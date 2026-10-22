const NEG = Number.NEGATIVE_INFINITY;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

export function createDecoder(labels, { bBias = 0, eBias = 0 } = {}) {
  const n = labels.length;
  const index = new Map(labels.map((label, i) => [label, i]));
  const types = labels.filter((label) => label.startsWith("S-")).map((label) => label.slice(2));
  if (index.get("O") === undefined) throw Object.assign(new Error("label list lacks O"), { code: "INVALID_LABELS" });
  for (const type of types) {
    for (const tag of ["B", "I", "E", "S"]) {
      if (index.get(`${tag}-${type}`) === undefined) {
        throw Object.assign(new Error(`label list lacks ${tag}-${type}`), { code: "INVALID_LABELS" });
      }
    }
  }
  const trans = Array.from({ length: n }, () => new Float64Array(n).fill(NEG));
  const ends = [index.get("O")];
  const begins = [index.get("O")];
  for (const type of types) {
    const b = index.get(`B-${type}`);
    const i = index.get(`I-${type}`);
    const e = index.get(`E-${type}`);
    const s = index.get(`S-${type}`);
    ends.push(e, s);
    begins.push(b, s);
    trans[b][i] = 0;
    trans[b][e] = 0;
    trans[i][i] = 0;
    trans[i][e] = 0;
  }
  for (const from of ends) for (const to of begins) trans[from][to] = 0;
  for (const type of types) {
    const b = index.get(`B-${type}`);
    const e = index.get(`E-${type}`);
    for (let from = 0; from < n; from++) if (trans[from][b] > NEG) trans[from][b] += bBias;
    for (let to = 0; to < n; to++) if (trans[e][to] > NEG) trans[e][to] += eBias;
  }
  const startAllowed = labels.map((label) => label === "O" || label.startsWith("B-") || label.startsWith("S-"));
  const endAllowed = labels.map((label) => label === "O" || label.startsWith("E-") || label.startsWith("S-"));

  function bestPath(logits) {
    const steps = logits.length;
    const back = Array.from({ length: steps }, () => new Int16Array(n));
    let prev = new Float64Array(n);
    for (let c = 0; c < n; c++) prev[c] = startAllowed[c] ? logits[0][c] : NEG;
    for (let t = 1; t < steps; t++) {
      const next = new Float64Array(n);
      for (let to = 0; to < n; to++) {
        let best = NEG;
        let arg = 0;
        for (let from = 0; from < n; from++) {
          const score = prev[from] + trans[from][to];
          if (score > best) {
            best = score;
            arg = from;
          }
        }
        next[to] = best + logits[t][to];
        back[t][to] = arg;
      }
      prev = next;
    }
    let last = 0;
    let best = NEG;
    for (let c = 0; c < n; c++) {
      const score = endAllowed[c] ? prev[c] : NEG;
      if (score > best) {
        best = score;
        last = c;
      }
    }
    const path = new Array(steps);
    path[steps - 1] = last;
    for (let t = steps - 1; t > 0; t--) path[t - 1] = back[t][path[t]];
    return path;
  }

  function decode(logits) {
    if (!logits.length) return [];
    const path = bestPath(logits);
    const spans = [];
    let t = 0;
    while (t < path.length) {
      const label = labels[path[t]];
      if (label.startsWith("S-")) {
        spans.push({ label: label.slice(2), first: t, last: t, score: sigmoid(logits[t][path[t]]) });
        t += 1;
      } else if (label.startsWith("B-")) {
        const type = label.slice(2);
        const first = t;
        const scores = [logits[t][path[t]]];
        t += 1;
        while (t < path.length) {
          const inner = labels[path[t]];
          if (inner !== `I-${type}` && inner !== `E-${type}`) break;
          scores.push(logits[t][path[t]]);
          t += 1;
          if (inner === `E-${type}`) break;
        }
        const mean = scores.reduce((acc, value) => acc + value, 0) / scores.length;
        spans.push({ label: type, first, last: t - 1, score: sigmoid(mean) });
      } else {
        t += 1;
      }
    }
    return spans;
  }

  return { decode, labels, types };
}
