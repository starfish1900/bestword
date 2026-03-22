// ═══════════════════════════════════════════════════════════════════════════════
// GADDAG — Array-packed, DAWG-minimized Generalized Directed Acyclic Word Graph
// Used for efficient move generation in BestWord/ChosenWord
// ═══════════════════════════════════════════════════════════════════════════════

const SEP = '>'; // GADDAG separator (marks direction reversal)

// Letter codes for packed 32-bit representation (6 bits = 0-63)
const LETTER_TO_CODE = {};
const CODE_TO_LETTER = {};
for (let i = 0; i < 26; i++) {
  const ch = String.fromCharCode(65 + i);
  LETTER_TO_CODE[ch] = i + 1;    // A=1 .. Z=26
  CODE_TO_LETTER[i + 1] = ch;
}
LETTER_TO_CODE['Ç'] = 27; CODE_TO_LETTER[27] = 'Ç';
LETTER_TO_CODE['Ñ'] = 28; CODE_TO_LETTER[28] = 'Ñ';
LETTER_TO_CODE[SEP] = 29; CODE_TO_LETTER[29] = SEP;

// ─── Trie node (used during construction only, discarded after packing) ────────
class GNode {
  constructor() {
    this.children = {};
    this.isTerminal = false;
    this._sig = null;
  }
  signature() {
    if (this._sig !== null) return this._sig;
    let s = this.isTerminal ? '1' : '0';
    const keys = Object.keys(this.children).sort();
    for (const k of keys) {
      s += '(' + k + this.children[k].signature() + ')';
    }
    this._sig = s;
    return this._sig;
  }
}

// ─── Packed GADDAG ─────────────────────────────────────────────────────────────
// Each entry is a 32-bit integer:
//   bits  0-5:  letter code (0-63)
//   bit   6:    terminal flag (word ends at this arc's target)
//   bit   7:    last-child flag (last sibling arc)
//   bits  8-31: child pointer (index of target node's first arc; 0 = no children)
//
// A "node" is a sequence of consecutive arcs (entries) in the array.
// Index 0 is a sentinel (no children).

class GADDAG {
  constructor(data, rootIndex) {
    this.data = data;       // Uint32Array
    this.rootIndex = rootIndex;
  }

  // Follow edge `ch` from node at `nodeIndex`.
  // Returns { index, terminal } or null.
  getChild(nodeIndex, ch) {
    if (nodeIndex <= 0) return null;
    const code = LETTER_TO_CODE[ch];
    if (!code) return null;
    const data = this.data;
    let i = nodeIndex;
    while (true) {
      const entry = data[i];
      const c = entry & 0x3F;
      if (c === code) {
        return {
          index: (entry >>> 8) & 0xFFFFFF,
          terminal: !!((entry >>> 6) & 1)
        };
      }
      if ((entry >>> 7) & 1) return null; // last child
      i++;
    }
  }

  // Iterate all children of node at `nodeIndex`.
  // Calls fn(letter, childIndex, isTerminal) for each.
  forEachChild(nodeIndex, fn) {
    if (nodeIndex <= 0) return;
    const data = this.data;
    let i = nodeIndex;
    while (true) {
      const entry = data[i];
      const code = entry & 0x3F;
      const terminal = !!((entry >>> 6) & 1);
      const last = !!((entry >>> 7) & 1);
      const ptr = (entry >>> 8) & 0xFFFFFF;
      const letter = CODE_TO_LETTER[code];
      if (letter) fn(letter, ptr, terminal);
      if (last) break;
      i++;
    }
  }

  // ─── Load from pre-built binary file ────────────────────────────────────────
  static load(filePath) {
    const fs = require('fs');
    const buf = fs.readFileSync(filePath);
    const rootIndex = buf.readUInt32LE(0);
    // Copy the body into a properly aligned Uint32Array
    const bodyBuf = buf.subarray(4);
    const data = new Uint32Array(bodyBuf.buffer.slice(bodyBuf.byteOffset, bodyBuf.byteOffset + bodyBuf.byteLength));
    const sizeMB = (data.byteLength / (1024 * 1024)).toFixed(2);
    console.log(`GADDAG loaded: ${data.length} arcs, ${sizeMB} MB, root=${rootIndex}`);
    return new GADDAG(data, rootIndex);
  }

  // ─── Build from word list ──────────────────────────────────────────────────
  static build(words) {
    const t0 = Date.now();

    // Phase 1: Build trie
    const root = new GNode();
    let count = 0;
    for (const word of words) {
      if (word.length < 3 || word.length > 15) continue;
      const n = word.length;
      for (let i = 0; i < n; i++) {
        let node = root;
        // Reversed prefix: word[i], word[i-1], ..., word[0]
        for (let j = i; j >= 0; j--) {
          const ch = word[j];
          if (!node.children[ch]) node.children[ch] = new GNode();
          node = node.children[ch];
        }
        // Suffix after anchor: add separator then word[i+1..n-1]
        if (i < n - 1) {
          if (!node.children[SEP]) node.children[SEP] = new GNode();
          node = node.children[SEP];
          for (let j = i + 1; j < n; j++) {
            const ch = word[j];
            if (!node.children[ch]) node.children[ch] = new GNode();
            node = node.children[ch];
          }
        }
        node.isTerminal = true;
      }
      count++;
    }

    // Phase 2: Minimize (signature-based DAWG deduplication)
    const sigMap = new Map();
    function minimize(node) {
      for (const k of Object.keys(node.children)) {
        minimize(node.children[k]);
        const sig = node.children[k].signature();
        if (sigMap.has(sig)) {
          node.children[k] = sigMap.get(sig);
        } else {
          sigMap.set(sig, node.children[k]);
        }
      }
    }
    minimize(root);

    // Phase 3: Pack into flat Uint32Array (bottom-up: children before parents)
    const entries = [0]; // index 0 = sentinel (no children)
    const nodeMap = new Map();

    function pack(node) {
      if (nodeMap.has(node)) return nodeMap.get(node);
      const keys = Object.keys(node.children).sort();
      if (keys.length === 0) {
        nodeMap.set(node, 0);
        return 0;
      }
      // Pack all children first (so their indices are known)
      const childPtrs = {};
      for (const k of keys) {
        childPtrs[k] = pack(node.children[k]);
      }
      // Allocate arcs for this node
      const myIndex = entries.length;
      nodeMap.set(node, myIndex);
      for (let i = 0; i < keys.length; i++) {
        const ch = keys[i];
        const child = node.children[ch];
        const code = LETTER_TO_CODE[ch];
        const terminal = child.isTerminal ? 1 : 0;
        const last = (i === keys.length - 1) ? 1 : 0;
        const ptr = childPtrs[ch];
        entries.push((code & 0x3F) | (terminal << 6) | (last << 7) | ((ptr & 0xFFFFFF) << 8));
      }
      return myIndex;
    }

    const rootIndex = pack(root);
    const packed = new Uint32Array(entries);
    const sizeMB = (packed.byteLength / (1024 * 1024)).toFixed(2);
    const elapsed = Date.now() - t0;
    console.log(`GADDAG: ${count} words, ${sigMap.size} unique nodes, ${packed.length} arcs, ${sizeMB} MB, ${elapsed}ms`);

    return new GADDAG(packed, rootIndex);
  }
}

module.exports = { GADDAG, SEP, LETTER_TO_CODE, CODE_TO_LETTER };
