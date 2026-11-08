// Parse JSC_map.cpp / JSC_list.cpp tuple tables into JS arrays (latin1 byte strings).
import fs from "node:fs";

const SIMPLE = { n: "\n", t: "\t", r: "\r", "\\": "\\", '"': '"', "'": "'", "?": "?", a: "\x07", b: "\b", f: "\f", v: "\v" };

export function unC(s) {
  // decode a C string literal body into a latin1 byte string
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch !== "\\") { out += ch; continue; }
    const n = s[++i];
    if (n === "x") {
      let h = "";
      while (/[0-9a-fA-F]/.test(s[i + 1] ?? "")) h += s[++i];
      out += String.fromCharCode(parseInt(h, 16) & 0xff);
    } else if (/[0-7]/.test(n)) {
      let o = n;
      while (o.length < 3 && /[0-7]/.test(s[i + 1] ?? "")) o += s[++i];
      out += String.fromCharCode(parseInt(o, 8));
    } else if (n in SIMPLE) {
      out += SIMPLE[n];
    } else {
      throw new Error("unknown escape \\" + n);
    }
  }
  return out;
}

export function parseTable(src, name) {
  const start = src.indexOf(name);
  if (start < 0) throw new Error("no table " + name);
  const body = src.slice(src.indexOf("{", start) + 1);
  const end = body.indexOf("\n};");
  const text = body.slice(0, end);
  const re = /\{\s*((?:"(?:[^"\\]|\\.)*"\s*)+)(?:\/\*.*?\*\/)?\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/g;
  const rows = [];
  let m;
  while ((m = re.exec(text))) {
    const parts = [...m[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => unC(x[1]));
    rows.push({ str: parts.join(""), size: +m[2], index: +m[3] });
  }
  return rows;
}

export function load(dir) {
  const map = parseTable(fs.readFileSync(dir + "/JSC_map.cpp", "latin1"), "JSC::map[");
  const listSrc = fs.readFileSync(dir + "/JSC_list.cpp", "latin1");
  const list = parseTable(listSrc, "JSC::list[");
  const prefix = parseTable(listSrc, "JSC::prefix[");
  return { map, list, prefix };
}
