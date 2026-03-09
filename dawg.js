// DAWG - Directed Acyclic Word Graph for fast dictionary lookup
// Built using a trie then minimized into a DAWG

class DAWGNode {
  constructor() {
    this.children = {};
    this.isEnd = false;
    this._signature = null;
  }

  signature() {
    if (this._signature !== null) return this._signature;
    let sig = this.isEnd ? '1' : '0';
    const keys = Object.keys(this.children).sort();
    for (const k of keys) {
      sig += '(' + k + this.children[k].signature() + ')';
    }
    this._signature = sig;
    return sig;
  }
}

class DAWG {
  constructor() {
    this.root = new DAWGNode();
    this.wordCount = 0;
  }

  // Build from array of words
  static build(words) {
    const dawg = new DAWG();
    // Insert all words into trie
    for (const word of words) {
      dawg._insert(word.toUpperCase().trim());
    }
    // Minimize trie into DAWG
    dawg._minimize();
    dawg.wordCount = words.length;
    return dawg;
  }

  _insert(word) {
    let node = this.root;
    for (const ch of word) {
      if (!node.children[ch]) {
        node.children[ch] = new DAWGNode();
      }
      node = node.children[ch];
    }
    node.isEnd = true;
  }

  _minimize() {
    const sigMap = new Map();

    const minimize = (node) => {
      const keys = Object.keys(node.children);
      for (const k of keys) {
        minimize(node.children[k]);
        const sig = node.children[k].signature();
        if (sigMap.has(sig)) {
          node.children[k] = sigMap.get(sig);
        } else {
          sigMap.set(sig, node.children[k]);
        }
      }
    };

    minimize(this.root);
  }

  isWord(word) {
    let node = this.root;
    for (const ch of word.toUpperCase()) {
      if (!node.children[ch]) return false;
      node = node.children[ch];
    }
    return node.isEnd;
  }

  // Get all words matching a prefix
  hasPrefix(prefix) {
    let node = this.root;
    for (const ch of prefix.toUpperCase()) {
      if (!node.children[ch]) return false;
      node = node.children[ch];
    }
    return true;
  }

  // Get words between length min and max
  getWordsOfLength(minLen, maxLen) {
    const results = [];
    const dfs = (node, word) => {
      if (word.length > maxLen) return;
      if (node.isEnd && word.length >= minLen && word.length <= maxLen) {
        results.push(word);
      }
      for (const ch of Object.keys(node.children).sort()) {
        dfs(node.children[ch], word + ch);
      }
    };
    dfs(this.root, '');
    return results;
  }
}

module.exports = { DAWG };
