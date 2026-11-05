/*
 * Game Master Interactive Screen (plugin id: game-master-screen)
 * Copyright (c) 2026 Majsnic - MIT License.
 *
 * A system-agnostic game master screen for Obsidian, laid out like a real
 * GM screen:
 * - Tabs: as many screens as you like (notes, combat, maps…).
 * - Tiles you place anywhere on a screen: notes, single sections, single
 *   TTRPG Tools maps, the party, and the session diary. Note tiles show
 *   just their name; a click opens the content in a floating popup.
 * - Party: live cards per character (One DnD Character Sheet aware).
 * - Search: titles, aliases, headings, properties (optionally full text),
 *   with categories; results open in a popup or go straight on the screen.
 * - Session notes: a writing pad (with timestamped quick notes) that becomes
 *   the session note on Done, using a name pattern + template.
 *
 * Plain JavaScript, no build step.
 */

"use strict";

const obsidian = require("obsidian");
const {
  Plugin,
  ItemView,
  Component,
  Menu,
  Modal,
  FuzzySuggestModal,
  normalizePath,
  moment,
  MarkdownRenderer,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  Notice,
  setIcon,
  debounce,
  getAllTags,
} = obsidian;

const VIEW_TYPE = "game-master-screen-view";
const SHEET_ID = "onednd-character-sheet";
const DEFAULT_SHEET_DATA_FOLDER = "Kompendium/Character Sheet Data";

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

/*
 * Field source syntax (Settings → Game Master Interactive Screen → Party fields):
 *   armor_class            a property of the character note (dots reach into objects)
 *   @Spells.spell_save_dc  a property of a One DnD Character Sheet companion note
 *   $passive:Passive Perception   a sense from the sheet's senses list
 *   $conditions            active conditions (+ exhaustion) from the sheet
 *   $slots                 spell slots, calculated like the sheet does
 * Display types: text, bar (current/max, optional temp), tags, pips.
 */
const PRESETS = {
  dnd2024: {
    name: "D&D 2024 (One DnD Character Sheet)",
    nameKey: "character_name",
    subtitleKeys: ["class", "level"],
    imageKey: "cover",
    fields: [
      { label: "HP", display: "bar", source: "hp_current", max: "hp_max", temp: "temp_hp" },
      { label: "AC", display: "shield", source: "armor_class" },
      { label: "Perception", display: "text", source: "$passive:Passive Perception", group: "Passive" },
      { label: "Insight", display: "text", source: "$passive:Passive Insight", group: "Passive" },
      { label: "Investigation", display: "text", source: "$passive:Passive Investigation", group: "Passive" },
      { label: "Save DC", display: "text", source: "$spelldc", group: "Spellcasting" },
      { label: "Attack", display: "text", source: "$spellattack", group: "Spellcasting" },
      { label: "Conditions", display: "tags", source: "$conditions" },
      { label: "Slots", display: "pips", source: "$slots" },
    ],
    categories: [
      { name: "Spells", folders: [], tags: ["spell"] },
      { name: "Monsters", folders: [], tags: ["monster"] },
      { name: "Items", folders: [], tags: ["item"] },
      { name: "NPCs", folders: [], tags: ["npc"] },
      { name: "Rules", folders: [], tags: ["rules"] },
    ],
  },
  cpred: {
    name: "Cyberpunk RED",
    nameKey: "handle",
    subtitleKeys: ["role", "rank"],
    imageKey: "portrait",
    fields: [
      { label: "HP", display: "bar", source: "hp_current", max: "hp_max" },
      { label: "SP Body", display: "shield", source: "sp_body" },
      { label: "SP Head", display: "text", source: "sp_head" },
      { label: "Hum", display: "text", source: "humanity" },
      { label: "REF", display: "text", source: "ref" },
      { label: "DEX", display: "text", source: "dex" },
      { label: "MOVE", display: "text", source: "move" },
      { label: "Luck", display: "text", source: "luck" },
      { label: "Conditions", display: "tags", source: "conditions" },
    ],
    categories: [
      { name: "NPCs", folders: [], tags: ["npc"] },
      { name: "Gear", folders: [], tags: ["gear"] },
      { name: "Cyberware", folders: [], tags: ["cyberware"] },
      { name: "Rules", folders: [], tags: ["rules"] },
    ],
  },
  generic: {
    name: "Generic",
    nameKey: "name",
    subtitleKeys: [],
    imageKey: "image",
    fields: [{ label: "HP", display: "bar", source: "hp_current", max: "hp_max" }],
    categories: [],
  },
};

const DEFAULT_SETTINGS = {
  preset: "dnd2024",
  nameKey: PRESETS.dnd2024.nameKey,
  subtitleKeys: PRESETS.dnd2024.subtitleKeys.slice(),
  imageKey: PRESETS.dnd2024.imageKey,
  fields: clone(PRESETS.dnd2024.fields),
  categories: clone(PRESETS.dnd2024.categories),
  party: { mode: "sheetGroup", value: "" },
  useSheet: true,
  compactParty: false,
  fullText: false,
  resultLimit: 30,
  screens: null, // [{ id, name, tiles: [...] }] - built on first load
  activeScreen: null,
  openIn: "main",
  combat: { folder: "Encounters" },
  dice: { anim3d: true, catchDiceRoller: true, initiativeInTray: true, history: [] },
  showCombatBar: true,
  concentration: true,
  templates: [],
  openOnStart: false,
  diary: {
    folder: "",
    pattern: "Session {{number}} - {{title}}",
    pad: 0,
    dateFormat: "YYYY-MM-DD",
    templatePath: "",
    templateText: "---\ndate: {{date}}\ntags:\n  - session\n---\n# Session {{number}}: {{title}}\n\n## Notes\n{{notes}}\n",
    draft: "",
    current: "",
  },
};

/* ------------------------------------------------------------------ */
/* Pure helpers (no Obsidian objects)                                  */
/* ------------------------------------------------------------------ */

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** Lowercase and strip diacritics so "prisera" finds "Příšera". */
function norm(s) {
  return String(s == null ? "" : s)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function toInt(v) {
  if (v === null || v === undefined || v === "") return undefined;
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v) : undefined;
  const m = /-?\d+/.exec(String(v));
  return m ? parseInt(m[0], 10) : undefined;
}

/** Read a dotted path from an object: "a.b.c". */
function getPath(obj, path) {
  if (!obj || !path) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, path)) return obj[path];
  let cur = obj;
  for (const part of String(path).split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/** "[[Echo|E]]" -> "Echo", "![[a.png]]" -> "a.png" */
function stripLink(s) {
  const t = String(s || "").trim();
  const m = /^!?\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]$/.exec(t);
  if (m) return m[1].trim();
  const md = /^!?\[[^\]]*\]\(([^)]+)\)$/.exec(t);
  if (md) return md[1].trim();
  return t;
}

/** Flatten frontmatter scalars into one searchable string. */
function flattenValues(fm, cap = 600) {
  const out = [];
  const walk = (v, depth) => {
    if (out.join(" ").length > cap || depth > 3) return;
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v === "object") return Object.values(v).forEach((x) => walk(x, depth + 1));
    out.push(String(v));
  };
  if (fm) for (const [k, v] of Object.entries(fm)) {
    if (k === "position" || k === "cssclasses") continue;
    walk(v, 0);
  }
  return out.join(" ").slice(0, cap);
}

/**
 * Score one index entry against a query. Every word of the query has to
 * match somewhere (title, alias, heading or property). Returns
 * { score, heading } or null.
 */
function scoreEntry(entry, query) {
  const q = norm(query).trim();
  if (!q) return null;
  const tokens = q.split(/\s+/).filter(Boolean);
  let total = 0;
  let heading = null;
  for (const t of tokens) {
    let best = 0;
    if (entry.titleN === t) best = 100;
    else if (entry.titleN.startsWith(t)) best = entry.titleWords[0] === t ? 85 : 80;
    else if (entry.titleWords.includes(t)) best = 75;
    else if (entry.titleWords.some((w) => w.startsWith(t))) best = 70;
    else if (entry.titleN.includes(t)) best = 60;
    if (best < 50 && entry.aliasesN.some((a) => a.includes(t))) best = 50;
    if (best < 35) {
      const h = entry.headings.find((x) => x.n.includes(t));
      if (h) {
        best = 35;
        if (!heading) heading = h.text;
      }
    }
    if (best < 20 && entry.fmN.includes(t)) best = 20;
    if (!best) return null;
    total += best;
  }
  if (tokens.length > 1 && entry.titleN.includes(q)) total += 50;
  // Shorter titles first when scores tie ("Imp" before "Imp Trickster")
  total -= Math.min(entry.titleN.length, 60) / 100;
  return { score: total, heading: total >= 60 * tokens.length ? null : heading };
}

/**
 * Spell slots exactly like the One DnD Character Sheet computes them
 * (single class, multiclass and Pact Magic). `tables` is the sheet's
 * own SPELL_SLOT_TABLES. Returns [{ level, total, used }].
 */
const CLASS_PROGRESSION = {
  bard: "full", cleric: "full", druid: "full", sorcerer: "full", wizard: "full",
  paladin: "half", ranger: "half",
  artificer: "artificer",
  warlock: "pact",
};
const THIRD_CASTER_SUBCLASSES = ["eldritch knight", "arcane trickster"];

function computeSlots(tables, fm, abFm, spellsFm) {
  if (!tables) return [];
  fm = fm || {};
  abFm = abFm || {};
  const classNames = String(fm.class || "").split(" / ").map((s) => s.trim()).filter(Boolean);
  const subclassNames = String(abFm.subclass || "").split(" / ").map((s) => s.trim()).filter(Boolean);
  const classLevels = abFm.class_levels || {};
  const third = subclassNames.some((s) => THIRD_CASTER_SUBCLASSES.includes(s.toLowerCase()));
  const levelFor = (c) => (classNames.length <= 1 ? Number(fm.level) || 0 : Number(classLevels[c]) || 0);
  const progs = classNames
    .map((c) => ({ name: c, type: CLASS_PROGRESSION[c.toLowerCase()] || (third ? "third" : undefined), level: levelFor(c) }))
    .filter((c) => c.type);
  const warlock = progs.find((c) => c.type === "pact");
  const others = progs.filter((c) => c.type !== "pact");
  const edition = String(abFm.rules_edition || "2024").trim();
  const lookup = (type, level) => {
    if (!type || level <= 0) return {};
    const key = type === "half" ? `half_${edition}` : type;
    return (tables[key] || {})[String(level)] || {};
  };
  let combined = {};
  if (others.length === 1 && !warlock) combined = lookup(others[0].type, others[0].level);
  else if (others.length >= 1) {
    let lvl = 0;
    for (const c of others) {
      if (c.type === "full") lvl += c.level;
      else if (c.type === "half") lvl += Math.floor(c.level / 2);
      else if (c.type === "third") lvl += Math.floor(c.level / 3);
      else if (c.type === "artificer") lvl += Math.ceil(c.level / 2);
    }
    combined = lookup("full", lvl);
  }
  const pact = warlock ? lookup("pact", warlock.level) : {};
  const split = !!warlock && others.length > 0;
  const used = (spellsFm && spellsFm.spell_slots_used) || {};
  const by = {};
  const add = (table, prefix) => {
    for (const [lvl, max] of Object.entries(table)) {
      if (!max) continue;
      const u = Math.min(Number(used[prefix + lvl]) || 0, max);
      const cur = by[lvl] || { level: Number(lvl), total: 0, used: 0 };
      cur.total += max;
      cur.used += u;
      by[lvl] = cur;
    }
  };
  add(combined, split ? "std_" : "");
  add(pact, split ? "pact_" : "");
  return Object.values(by).sort((a, b) => a.level - b.level);
}

function ordinal(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

/* ------------------------------------------------------------------ */
/* Character data                                                      */
/* ------------------------------------------------------------------ */

class PartyReader {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
  }
  get sheet() {
    if (!this.plugin.settings.useSheet) return null;
    const p = this.app.plugins && this.app.plugins.plugins;
    return (p && p[SHEET_ID]) || null;
  }
  get dataFolder() {
    const s = this.sheet && this.sheet.settings;
    return (s && s.dataFolder) || DEFAULT_SHEET_DATA_FOLDER;
  }
  fm(file) {
    const c = this.app.metadataCache.getFileCache(file);
    return (c && c.frontmatter) || {};
  }
  companionPath(file, fm, kind) {
    return `${this.dataFolder}/${fm.data_id || file.basename}/${kind}.md`;
  }
  companion(file, fm, kind) {
    const f = this.app.vault.getAbstractFileByPath(this.companionPath(file, fm, kind));
    return f instanceof TFile ? this.fm(f) : {};
  }
  sheetGroups() {
    const s = this.sheet && this.sheet.settings;
    return (s && Array.isArray(s.partyGroups) && s.partyGroups) || [];
  }
  resolveNote(name, from = "") {
    const n = stripLink(name).replace(/\.md$/, "");
    if (!n) return null;
    const f = this.app.metadataCache.getFirstLinkpathDest(n, from);
    return f instanceof TFile ? f : null;
  }

  /** The party's notes, in display order. A party tile can keep its own list (tile.members). */
  members(tile) {
    if (tile && Array.isArray(tile.members)) {
      return tile.members.map((p) => this.app.vault.getAbstractFileByPath(p)).filter((f) => f instanceof TFile);
    }
    const { mode, value } = this.plugin.settings.party || {};
    const v = String(value || "").trim();
    let files = [];
    if (mode === "sheetGroup") {
      const groups = this.sheetGroups();
      const g = groups.find((x) => x.name === v) || groups[0];
      if (g) files = (g.members || []).map((m) => this.resolveNote(m));
    } else if (mode === "folder") {
      const folder = this.app.vault.getAbstractFileByPath(v.replace(/\/+$/, ""));
      if (folder instanceof TFolder) {
        files = folder.children.filter((f) => f instanceof TFile && f.extension === "md" && f.basename !== folder.name);
        files.sort((a, b) => a.basename.localeCompare(b.basename));
      }
    } else if (mode === "tag") {
      const tag = norm(v.replace(/^#/, ""));
      if (tag) {
        files = this.app.vault.getMarkdownFiles().filter((f) => {
          const c = this.app.metadataCache.getFileCache(f);
          return c && (getAllTags(c) || []).some((t) => norm(t.replace(/^#/, "")) === tag);
        });
        files.sort((a, b) => a.basename.localeCompare(b.basename));
      }
    } else if (mode === "list") {
      files = v.split(/\n|,/).map((s) => this.resolveNote(s));
    }
    const seen = new Set();
    return files.filter((f) => f && !seen.has(f.path) && seen.add(f.path));
  }

  /** Everything a card needs, plus the paths to watch for live updates. */
  read(file) {
    const s = this.plugin.settings;
    const fm = this.fm(file);
    const watch = new Set([file.path]);
    const companions = {};
    const comp = (kind) => {
      if (!companions[kind]) {
        watch.add(this.companionPath(file, fm, kind));
        companions[kind] = this.companion(file, fm, kind);
      }
      return companions[kind];
    };
    const get = (source) => this.value(file, fm, comp, source);
    const fields = (s.fields || []).map((f) => {
      const out = { ...f, value: get(f.source) };
      if (f.display === "bar") {
        const cur = toInt(out.value);
        const max = toInt(get(f.max));
        out.value = { cur: cur === undefined ? max : cur, max, temp: toInt(get(f.temp)) || 0 };
      }
      return out;
    });
    const nameVal = getPath(fm, s.nameKey);
    const subtitle = (s.subtitleKeys || [])
      .map((k) => getPath(fm, k))
      .filter((v) => v !== undefined && v !== null && v !== "")
      .join(" ");
    const classes = Array.isArray(fm.cssclasses) ? fm.cssclasses : [];
    return {
      file,
      name: (typeof nameVal === "string" && nameVal.trim()) || file.basename,
      subtitle,
      image: this.imageUrl(getPath(fm, s.imageKey), file),
      fields,
      dying: classes.includes("dying"),
      dead: classes.includes("dead"),
      watch: [...watch],
    };
  }

  value(file, fm, comp, source) {
    const src = String(source || "").trim();
    if (!src) return undefined;
    if (src.startsWith("$")) {
      if (!this.sheet && !src.startsWith("$conditions")) return undefined;
      const [kind, arg] = src.slice(1).split(/:(.*)/s);
      if (kind === "passive") {
        const list = comp("Abilities").senses_list;
        const hit = Array.isArray(list) ? list.find((x) => x && norm(x.name) === norm(arg)) : null;
        return hit ? hit.value : undefined;
      }
      if (kind === "conditions") {
        const c = comp("Conditions");
        const list = Array.isArray(c.conditions_active) ? c.conditions_active.map(String) : [];
        const ex = Number(c.exhaustion_level || 0);
        if (ex > 0) list.push(`Exhaustion ${ex}`);
        return list;
      }
      if (kind === "spelldc" || kind === "spellattack") {
        const stored = comp("Spells")[kind === "spelldc" ? "spell_save_dc" : "spell_attack_bonus"];
        if (stored !== undefined && stored !== null && String(stored).trim() !== "") return String(stored);
        const sc = spellcasting(fm, comp("Abilities"));
        if (!sc) return undefined;
        return kind === "spelldc" ? String(sc.dc) : signed(sc.attack);
      }
      if (kind === "slots") {
        return computeSlots(this.sheet && this.sheet.SPELL_SLOT_TABLES, fm, comp("Abilities"), comp("Spells"));
      }
      return undefined;
    }
    if (src.startsWith("@")) {
      const m = /^@([^.]+)\.(.+)$/.exec(src);
      return m ? getPath(comp(m[1]), m[2]) : undefined;
    }
    return getPath(fm, src);
  }

  imageUrl(raw, file) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    const t = stripLink(raw);
    if (/^https?:\/\//i.test(t)) return t;
    const f = this.app.metadataCache.getFirstLinkpathDest(t, file.path);
    return f instanceof TFile ? this.app.vault.getResourcePath(f) : null;
  }
}

/* ------------------------------------------------------------------ */
/* Search index                                                        */
/* ------------------------------------------------------------------ */

class SearchIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.entries = null; // path -> entry
  }
  invalidate(path) {
    if (!this.entries) return;
    if (path) this.entries.delete(path);
    else this.entries = null;
  }
  entryFor(file) {
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const fm = cache.frontmatter || {};
    let aliases = fm.aliases || fm.alias || [];
    if (!Array.isArray(aliases)) aliases = [aliases];
    const titleN = norm(file.basename);
    return {
      file,
      path: file.path,
      titleN,
      titleWords: titleN.split(/[\s\-_,()/'.]+/).filter(Boolean),
      aliasesN: aliases.filter(Boolean).map(norm),
      headings: (cache.headings || []).slice(0, 40).map((h) => ({ text: h.heading, n: norm(h.heading) })),
      fmN: norm(flattenValues(fm)),
      tags: (getAllTags(cache) || []).map((t) => norm(t.replace(/^#/, ""))),
    };
  }
  all() {
    if (!this.entries) this.entries = new Map();
    const files = this.app.vault.getMarkdownFiles();
    if (this.entries.size !== files.length) {
      const live = new Set();
      for (const f of files) {
        live.add(f.path);
        if (!this.entries.has(f.path)) this.entries.set(f.path, this.entryFor(f));
      }
      for (const p of [...this.entries.keys()]) if (!live.has(p)) this.entries.delete(p);
    }
    return this.entries;
  }
  inCategory(entry, cat) {
    if (!cat) return true;
    const folders = (cat.folders || []).map((f) => String(f).replace(/\/+$/, "")).filter(Boolean);
    const tags = (cat.tags || []).map((t) => norm(String(t).replace(/^#/, ""))).filter(Boolean);
    if (!folders.length && !tags.length) return false;
    if (folders.some((f) => entry.path.startsWith(f + "/"))) return true;
    return tags.some((t) => entry.tags.some((et) => et === t || et.startsWith(t + "/")));
  }
  query(q, cat, limit) {
    const out = [];
    for (const e of this.all().values()) {
      if (!this.inCategory(e, cat)) continue;
      const r = scoreEntry(e, q);
      if (r) out.push({ file: e.file, score: r.score, heading: r.heading });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  }
  /** Slow path: full text. Yields to the UI; stops when `isStale()` says so. */
  async fullText(q, cat, limit, skip, isStale) {
    const needle = norm(q).trim();
    const out = [];
    if (needle.length < 3) return out;
    let n = 0;
    for (const e of this.all().values()) {
      if (skip.has(e.path) || !this.inCategory(e, cat)) continue;
      if (++n % 150 === 0) {
        await new Promise((r) => setTimeout(r, 0));
        if (isStale()) return null;
      }
      const text = norm(await this.app.vault.cachedRead(e.file));
      const i = text.indexOf(needle);
      if (i >= 0) {
        out.push({ file: e.file, score: 1, snippet: text.slice(Math.max(0, i - 40), i + needle.length + 60).replace(/\s+/g, " ") });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}


/* ------------------------------------------------------------------ */
/* Board, section, map and diary helpers (pure)                        */
/* ------------------------------------------------------------------ */

const GRID = 10;
const HEAD_H = 36; // a tile showing only its name
const snap = (v) => Math.max(0, Math.round(v / GRID) * GRID);
const uid = () => Math.random().toString(36).slice(2, 10);

const TILE_SIZES = {
  note: { w: 220, h: 360, ew: 440 },
  section: { w: 240, h: 320, ew: 440 },
  map: { w: 220, h: 440, ew: 600 },
  party: { w: 560, h: 330 },
  combat: { w: 240, h: 520, ew: 520 },
  dice: { w: 420, h: 400 },
  sticky: { w: 240, h: 230 },
  checklist: { w: 270, h: 320 },
  diary: { w: 440, h: 440 },
};
const TILE_ICONS = { note: "file-text", section: "heading", map: "map", party: "users", diary: "notebook-pen", combat: "swords", dice: "dices", sticky: "sticky-note", checklist: "list-checks" };
const ALWAYS_OPEN = ["party", "diary", "combat", "dice", "sticky", "checklist"];
const STICKY_COLORS = { yellow: "Yellow", pink: "Pink", blue: "Blue", green: "Green", orange: "Orange" };
const STICKY_SIZES = { s: ["Small", 0.8], m: ["Medium", 1], l: ["Large", 1.3], xl: ["Extra large", 1.7] }; // shown open unless shrunk

/** Heading text the way it reads on the page: no markup, links show their label. */
function cleanHeading(s) {
  return String(s || "")
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (m, a) => a.split("#").pop())
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~=]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

function quoteDepth(line) {
  const m = /^((?:\s*>)*)/.exec(line);
  return m ? (m[1].match(/>/g) || []).length : 0;
}
function stripQuotes(line, depth) {
  let out = line;
  for (let i = 0; i < depth; i++) out = out.replace(/^\s*> ?/, "");
  return out;
}
function frontmatterEnd(lines) {
  if (lines[0] !== "---") return 0;
  for (let i = 1; i < lines.length; i++) if (lines[i] === "---" || lines[i] === "...") return i + 1;
  return 0;
}

/**
 * A heading and everything under it, up to the next heading of the same or
 * a higher level (or the end of the callout it sits in). Works for headings
 * inside callouts too. Returns { md, startLine } or null.
 */
function extractSection(text, heading, level) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const want = norm(cleanHeading(heading));
  let fence = false;
  let start = -1;
  let lvl = 0;
  let depth = 0;
  let end = lines.length;
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const raw = lines[i];
    const d = quoteDepth(raw);
    const body = stripQuotes(raw, d);
    if (/^\s*(```|~~~)/.test(body)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(body);
    if (start < 0) {
      if (m && norm(cleanHeading(m[2])) === want && (!level || m[1].length === level)) {
        start = i;
        lvl = m[1].length;
        depth = d;
      }
      continue;
    }
    if (depth > 0 && d < depth && raw.trim() !== "") { end = i; break; }
    if (m && d === depth && m[1].length <= lvl) { end = i; break; }
  }
  if (start < 0) return null;
  const md = lines.slice(start, end).map((l) => stripQuotes(l, depth)).join("\n").replace(/\s+$/, "");
  return { md, startLine: start };
}

/** Every ```zoommap block in a note, in order: { start, end, yaml, id }. */
function findMapBlocks(text) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const d = quoteDepth(lines[i]);
    if (!/^\s*```zoommap\s*$/i.test(stripQuotes(lines[i], d))) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*```/.test(stripQuotes(lines[j], d))) j++;
    if (j >= lines.length) break;
    const yaml = lines.slice(i + 1, j).map((l) => stripQuotes(l, d)).join("\n");
    const idm = /^id:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(yaml);
    out.push({ start: i, end: j, yaml, id: idm ? idm[1].trim() : null });
    i = j;
  }
  return out;
}

/**
 * The markdown for one pinned map. Keeps the map's id the same as in its
 * own note (TTRPG Tools - Maps names unnamed maps after their line), so
 * its saved view and markers stay the same.
 */
function mapMarkdown(block, fill) {
  let lines = block.yaml.replace(/\s+$/, "").split("\n");
  // Filling the tile/popup: drop the note's own size so the map follows the window
  if (fill) lines = lines.filter((l) => !/^(width|height|resizable|resizeHandle|responsive|wrap|align)\s*:/.test(l));
  let yaml = lines.join("\n");
  if (!block.id) yaml = `id: map-${block.start}\n${yaml}`;
  if (fill) yaml += "\nwidth: 100%\nheight: 100%\nresizable: false\nresponsive: false";
  return "```zoommap\n" + yaml + "\n```";
}

function pickMap(blocks, tile) {
  if (tile.mapId) {
    const byId = blocks.find((b) => b.id === tile.mapId);
    if (byId) return byId;
  }
  if (tile.mapLine !== undefined) {
    const byLine = blocks.find((b) => b.start === tile.mapLine);
    if (byLine) return byLine;
  }
  return blocks[tile.mapIndex || 0] || null;
}

/* ---- Session diary ---- */

function padNum(n, pad) {
  const s = String(n);
  return pad > 1 ? s.padStart(pad, "0") : s;
}

/** Fill {{number}}, {{title}}, {{date}} and {{date:FORMAT}}. */
function fillTokens(text, vars, formatDate) {
  return String(text || "")
    .replace(/\{\{\s*number\s*\}\}/gi, vars.number)
    .replace(/\{\{\s*title\s*\}\}/gi, vars.title)
    .replace(/\{\{\s*date(?::([^}]+))?\s*\}\}/gi, (m, fmt) => formatDate(fmt ? fmt.trim() : null));
}

function cleanFileName(s) {
  return String(s).replace(/[\\/:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").replace(/[\s.-]+$/, "").trim();
}

/** Highest session number in a list of note names, using the text before {{number}}. */
function lastSessionNumber(names, pattern) {
  const i = String(pattern).search(/\{\{\s*number\s*\}\}/i);
  if (i < 0) return 0;
  const prefix = pattern.slice(0, i).replace(/\{\{[^}]*\}\}/g, "");
  const re = new RegExp("^" + prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(\\d+)", "i");
  let max = 0;
  for (const n of names) {
    const m = re.exec(n);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/** Party and diary are open unless collapsed; notes, sections and maps show only their name unless expanded. */
function isOpenTile(t) {
  return ALWAYS_OPEN.includes(t.type) ? !t.collapsed : !!t.expanded;
}
/** Where a tile sits and how big it is right now. Open size (w, h) is kept while it shows only its name (cw). */
function tileBox(t) {
  const open = isOpenTile(t);
  return { x: t.x, y: t.y, w: open ? t.w : t.cw || 220, h: open ? t.h : HEAD_H };
}

/**
 * Put the session notes into a template: at {{notes}} (keeping that line's
 * "> " prefix, so notes inside a callout stay inside it), or at the end. If
 * the template ends inside a callout, the notes continue that callout.
 */
function insertNotes(text, notes) {
  const body = String(notes || "").replace(/\s+$/, "");
  const lines = String(text || "").split("\n");
  const at = lines.findIndex((l) => /\{\{\s*notes\s*\}\}/i.test(l));
  if (at >= 0) {
    const [pre, post] = lines[at].split(/\{\{\s*notes\s*\}\}/i);
    const prefix = /^[\s>]*/.exec(pre)[0];
    const out = body
      ? body.split("\n").map((l, k) => ((k === 0 ? pre : prefix) + l).replace(/\s+$/, "")).join("\n") + (post || "")
      : (pre + (post || "")).replace(/\s+$/, "");
    lines.splice(at, 1, out);
    return lines.join("\n");
  }
  if (!body) return text;
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const last = lines.length ? lines[lines.length - 1] : "";
  if (/^\s*>/.test(last)) {
    const prefix = /^[\s>]*/.exec(last)[0].replace(/\s*$/, " ");
    if (!last.replace(/[\s>]/g, "")) lines.pop(); // drop the empty "> " placeholder line
    return lines.concat(body.split("\n").map((l) => (prefix + l).replace(/\s+$/, ""))).join("\n") + "\n";
  }
  return lines.join("\n") + "\n\n" + body + "\n";
}

/** Spell save DC and spell attack, calculated the way the character sheet does. */
const SPELLCASTING_ABILITY = {
  wizard: "int", artificer: "int",
  cleric: "wis", druid: "wis", ranger: "wis",
  bard: "cha", paladin: "cha", sorcerer: "cha", warlock: "cha",
};
function spellcasting(fm, abFm) {
  fm = fm || {};
  abFm = abFm || {};
  const classes = String(fm.class || "").split(" / ").map((x) => x.trim()).filter(Boolean);
  const subs = String(abFm.subclass || "").split(" / ").map((x) => x.trim()).filter(Boolean);
  let key = null;
  for (let i = 0; i < classes.length; i++) {
    if (THIRD_CASTER_SUBCLASSES.includes(String(subs[i] || "").toLowerCase())) { key = "int"; break; }
    const k = SPELLCASTING_ABILITY[classes[i].toLowerCase()];
    if (k) { key = k; break; }
  }
  if (!key) return null;
  const mod = toInt(abFm[`${key}_mod`]);
  const level = Number(fm.level) || 1;
  const prof = Math.ceil(level / 4) + 1;
  if (mod === undefined) return null;
  return { dc: 8 + mod + prof, attack: mod + prof };
}
function signed(n) {
  return n >= 0 ? `+${n}` : String(n);
}

/**
 * Snap a tile that is being dragged against the tiles around it: side by side
 * (with tops or bottoms lined up) or stacked (with left or right edges lined
 * up). Only kicks in within `th` pixels. Returns { x, y, snapped }.
 */
function snapToTiles(box, others, th = 12, gap = GRID) {
  const { w, h } = box;
  let bx = null;
  let by = null;
  const tryX = (v) => { const d = Math.abs(v - box.x); if (d <= th && (!bx || d < bx.d)) bx = { v, d }; };
  const tryY = (v) => { const d = Math.abs(v - box.y); if (d <= th && (!by || d < by.d)) by = { v, d }; };
  for (const o of others) {
    const sideBySide = box.y < o.y + o.h + th && box.y + h > o.y - th;
    const stacked = box.x < o.x + o.w + th && box.x + w > o.x - th;
    if (sideBySide) {
      tryX(o.x + o.w + gap); // to the right of it
      tryX(o.x - w - gap); // to the left of it
    }
    if (stacked) {
      tryY(o.y + o.h + gap); // below it
      tryY(o.y - h - gap); // above it
    }
  }
  // Once next to a tile, line the edges up too
  const nx = bx ? bx.v : box.x;
  const ny = by ? by.v : box.y;
  for (const o of others) {
    if (bx && (nx === o.x + o.w + gap || nx === o.x - w - gap)) { tryY(o.y); tryY(o.y + o.h - h); }
    if (by && (ny === o.y + o.h + gap || ny === o.y - h - gap)) { tryX(o.x); tryX(o.x + o.w - w); }
  }
  const x = bx ? bx.v : box.x;
  const y = by ? by.v : box.y;
  return { x: Math.max(0, x), y: Math.max(0, y), snapped: !!(bx || by) };
}

/** A ```roll-initiative block (Roll for Initiative) by its `id` line: { start, end, body }. */
function findInitiativeBlock(text, id) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^((?:\s*>)*\s*)(`{3,}|~{3,})\s*roll-initiative\b/.exec(lines[i]);
    if (!m) continue;
    let end = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const st = lines[j].slice(m[1].length).trim();
      if (st.startsWith(m[2]) && st.replace(/[`~]/g, "") === "") { end = j; break; }
    }
    if (end < 0) break;
    const body = lines.slice(i + 1, end).map((l) => l.slice(m[1].length));
    if (!id || body.some((l) => l.trim() === `id ${id}`)) return { start: i, end, body };
    i = end;
  }
  return null;
}

/** The text of a Roll for Initiative encounter block. */
function combatBlock(spec) {
  const out = [`name ${spec.name}`, `id ${spec.id}`];
  for (const p of spec.players) out.push(`[[${p}]] player`);
  for (const e of spec.creatures) {
    const count = Math.max(1, Math.min(50, Number(e.count) || 1));
    const head = count > 1 ? `${count}x ` : "";
    const who = e.link ? `[[${e.link}]]` : String(e.name || "Creature").replace(/[\[\]()]/g, "").trim();
    const stats = [];
    if (!e.link && e.hp) stats.push(`hp ${e.hp}`);
    if (!e.link && e.ac) stats.push(`ac ${e.ac}`);
    out.push(`${head}${who} ${e.side || "enemy"}${stats.length ? " " + stats.join(" ") : ""}`);
  }
  return out.join("\n");
}

/**
 * While resizing: let the right / bottom edge catch on neighbours - stop a
 * gap short of a tile beside or below, or line up with the far edge of a tile
 * above/below or beside. Returns { w, h, snapped }.
 */
function snapResize(box, others, th = 12, gap = GRID) {
  const right = box.x + box.w;
  const bottom = box.y + box.h;
  let bw = null;
  let bh = null;
  const tryW = (edge) => { const d = Math.abs(edge - right); if (d <= th && (!bw || d < bw.d)) bw = { v: edge - box.x, d }; };
  const tryH = (edge) => { const d = Math.abs(edge - bottom); if (d <= th && (!bh || d < bh.d)) bh = { v: edge - box.y, d }; };
  for (const o of others) {
    const sideBySide = box.y < o.y + o.h && bottom > o.y;
    const stacked = box.x < o.x + o.w && right > o.x;
    if (sideBySide && o.x > box.x) tryW(o.x - gap);
    if (stacked && o.y > box.y) tryH(o.y - gap);
    if (!sideBySide || o.y + o.h <= box.y || o.y >= bottom + th) {
      if (o.x + o.w > box.x) tryW(o.x + o.w);
    }
    if (!stacked || o.x + o.w <= box.x || o.x >= right + th) {
      if (o.y + o.h > box.y) tryH(o.y + o.h);
    }
  }
  return { w: bw ? bw.v : box.w, h: bh ? bh.v : box.h, snapped: !!(bw || bh) };
}

const isConcentration = (c) => /concentrat|soustřed/i.test(String((c && c.name) || c || ""));
/** D&D: concentration save DC after taking damage. */
const concentrationDC = (damage) => Math.min(30, Math.max(10, Math.floor(damage / 2)));

/** A screen as a shareable JSON object (tile ids dropped). */
function screenToJson(sc) {
  return {
    gmScreen: 1,
    name: sc.name,
    tiles: sc.tiles.map((t) => {
      const c = clone(t);
      delete c.id;
      return c;
    }),
  };
}
/** Read an exported screen back (string or object) → { name, tiles } or null. */
function screenFromJson(data) {
  let o = data;
  try {
    if (typeof o === "string") o = JSON.parse(o);
  } catch (e) {
    return null;
  }
  if (!o || !Array.isArray(o.tiles)) return null;
  const tiles = o.tiles
    .filter((t) => t && typeof t === "object" && TILE_ICONS[t.type])
    .map((t) => ({ ...clone(t), id: uid(), x: Number(t.x) || 0, y: Number(t.y) || 0, w: Number(t.w) || 240, h: Number(t.h) || 240 }));
  return { name: String(o.name || "Imported screen").slice(0, 60), tiles };
}

/** First free spot on a board for a tile of the given size. */
function freeSpot(tiles, w, h, width) {
  const rects = tiles.map(tileBox);
  const maxX = Math.max(w, snap(width - w - GRID));
  for (let y = 0; y < 5000; y += GRID * 2) {
    for (let x = 0; x <= maxX; x += GRID * 2) {
      const hit = rects.some((r) => x < r.x + r.w + GRID && x + w + GRID > r.x && y < r.y + r.h + GRID && y + h + GRID > r.y);
      if (!hit) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/* ------------------------------------------------------------------ */
/* Dice: rolling, 3D tray rendering, result card                       */
/* ------------------------------------------------------------------ */

/** Fair 1..n from the system's crypto random source. */
function rollDie(n) {
  const c = typeof crypto !== "undefined" && crypto.getRandomValues ? crypto : null;
  if (!c) return Math.floor(Math.random() * n) + 1;
  const a = new Uint32Array(1);
  const lim = Math.floor(0x100000000 / n) * n;
  let x;
  do {
    c.getRandomValues(a);
    x = a[0];
  } while (x >= lim);
  return (x % n) + 1;
}

/** "2d20kh1 + 1d4 - 1", "d%", "3d6+2" → terms, or null if it isn't a dice formula. */
function parseFormula(formula) {
  const src = String(formula || "").trim().replace(/\s*([+-])\s*/g, "$1").toLowerCase();
  if (!src || /\s/.test(src)) return null;
  const re = /([+-]?)(?:(\d*)d(\d+|%)(?:(kh|kl|k)(\d+))?|(\d+))/y;
  const terms = [];
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || !m[0]) return null;
    if (terms.length && !m[1]) return null; // later terms need a + or -
    const sign = m[1] === "-" ? -1 : 1;
    if (m[3]) {
      const count = m[2] === "" ? 1 : parseInt(m[2], 10);
      const sides = m[3] === "%" ? 100 : parseInt(m[3], 10);
      if (!count || count > 100 || sides < 2 || sides > 1000) return null;
      const t = { sign, count, sides };
      if (m[4]) t.keep = { lo: m[4] === "kl", n: Math.max(1, Math.min(count, parseInt(m[5], 10))) };
      terms.push(t);
    } else terms.push({ sign, value: parseInt(m[6], 10) });
    pos = re.lastIndex;
  }
  return terms.length ? terms : null;
}

/** Roll a formula: { formula, label, total, groups: [{ sides, sign, values, kept }], mod }. */
function rollFormula(formula, label, die = rollDie) {
  const terms = parseFormula(formula);
  if (!terms) return null;
  let total = 0;
  let mod = 0;
  const groups = [];
  for (const t of terms) {
    if (t.value !== undefined) {
      total += t.sign * t.value;
      mod += t.sign * t.value;
      continue;
    }
    const values = [];
    for (let i = 0; i < t.count; i++) values.push(die(t.sides));
    let kept = values.map(() => true);
    if (t.keep) {
      const order = values.map((v, i) => i).sort((a, b) => (t.keep.lo ? values[a] - values[b] : values[b] - values[a]));
      kept = values.map(() => false);
      order.slice(0, t.keep.n).forEach((i) => (kept[i] = true));
    }
    total += t.sign * values.reduce((s, v, i) => s + (kept[i] ? v : 0), 0);
    groups.push({ sides: t.sides, sign: t.sign, values, kept });
  }
  return { formula: String(formula).trim(), label: label || String(formula).trim(), total, groups, mod };
}

/** Turn a single d20 into advantage / disadvantage: "1d20+5" → "2d20kh1+5". */
function withAdvantage(formula, mode) {
  if (!mode) return formula;
  const k = mode === "adv" ? "kh1" : "kl1";
  return String(formula).replace(/(^|[+-]\s*)1?d20(?![\d%k])/i, (m, pre) => `${pre}2d20${k}`);
}

/** Natural 20 / natural 1 on the kept d20, if the roll has exactly one. */
function critOf(r) {
  const d20 = r.groups.filter((g) => g.sides === 20);
  if (d20.length !== 1) return null;
  const kept = d20[0].values.filter((v, i) => d20[0].kept[i]);
  if (kept.length !== 1) return null;
  return kept[0] === 20 ? "crit" : kept[0] === 1 ? "fumble" : null;
}

/** "d20 [14, 7] + 5" style breakdown; dropped dice are marked with ~. */
function breakdown(r) {
  const parts = r.groups.map((g, gi) => {
    const vals = g.values.map((v, i) => (g.kept[i] ? String(v) : `~${v}~`)).join(", ");
    const sign = gi === 0 && g.sign > 0 ? "" : g.sign < 0 ? "− " : "+ ";
    return `${sign}${g.values.length}d${g.sides} [${vals}]`;
  });
  if (r.mod) parts.push(`${r.mod < 0 ? "−" : "+"} ${Math.abs(r.mod)}`);
  return parts.join(" ");
}

/** A roll made by the Dice Roller plugin (character sheet buttons, statblocks) in our shape. */
function resultFromDiceRoller(roller, label) {
  if (!roller) return null;
  const total = Number(roller.result);
  if (!Number.isFinite(total)) return null;
  const groups = [];
  for (const c of roller.children || []) {
    if (!c || c.static) continue;
    const m = /(\d*)d(\d+|%)/i.exec(String(c.dice || ""));
    if (!m) continue;
    const sides = m[2] === "%" ? 100 : parseInt(m[2], 10);
    const values = [];
    const kept = [];
    if (c.results && typeof c.results.forEach === "function") {
      c.results.forEach((res) => {
        const v = Number(res && res.value);
        if (!Number.isFinite(v)) return;
        values.push(v);
        kept.push(!res || res.usable !== false);
      });
    }
    if (values.length) groups.push({ sides, sign: 1, values, kept });
  }
  const sum = groups.reduce((s, g) => s + g.values.reduce((a, v, i) => a + (g.kept[i] ? v : 0), 0), 0);
  const formula = String(roller.original || "").replace(/^dice:\s*/i, "").trim();
  return { formula, label: label || formula, total, groups, mod: total - sum, source: "Dice Roller" };
}

/* ---- tiny 3D maths ---- */

const V3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  },
};
const Q = {
  axis(ax, ang) {
    const n = V3.norm(ax);
    const s = Math.sin(ang / 2);
    return [Math.cos(ang / 2), n[0] * s, n[1] * s, n[2] * s];
  },
  mul(a, b) {
    return [
      a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
      a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
      a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
      a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
    ];
  },
  norm(q) {
    const l = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
    return q.map((x) => x / l);
  },
  rot(q, v) {
    const p = Q.mul(Q.mul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
    return [p[1], p[2], p[3]];
  },
  slerp(a, b, t) {
    let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
    if (d < 0) {
      b = b.map((x) => -x);
      d = -d;
    }
    if (d > 0.9995) return Q.norm(a.map((x, i) => x + (b[i] - x) * t));
    const th = Math.acos(d);
    const s = Math.sin(th);
    const wa = Math.sin((1 - t) * th) / s;
    const wb = Math.sin(t * th) / s;
    return a.map((x, i) => x * wa + b[i] * wb);
  },
  /** Rotation turning direction `from` onto `to`. */
  between(from, to) {
    const f = V3.norm(from);
    const t = V3.norm(to);
    const d = V3.dot(f, t);
    if (d > 0.99999) return [1, 0, 0, 0];
    if (d < -0.99999) return Q.axis(Math.abs(f[0]) < 0.9 ? V3.cross(f, [1, 0, 0]) : V3.cross(f, [0, 1, 0]), Math.PI);
    return Q.axis(V3.cross(f, t), Math.acos(d));
  },
};

/* ---- die shapes ---- */

const PHI = (1 + Math.sqrt(5)) / 2;
function polyFaces(verts, normals) {
  return normals.map((n0) => {
    const n = V3.norm(n0);
    let max = -Infinity;
    for (const v of verts) max = Math.max(max, V3.dot(v, n));
    const idx = [];
    verts.forEach((v, i) => {
      if (V3.dot(v, n) > max - 1e-3) idx.push(i);
    });
    const c = V3.scale(idx.reduce((s, i) => [s[0] + verts[i][0], s[1] + verts[i][1], s[2] + verts[i][2]], [0, 0, 0]), 1 / idx.length);
    const u = V3.norm(V3.sub(verts[idx[0]], c));
    const w = V3.cross(n, u);
    idx.sort((a, b) => {
      const pa = V3.sub(verts[a], c);
      const pb = V3.sub(verts[b], c);
      return Math.atan2(V3.dot(pa, w), V3.dot(pa, u)) - Math.atan2(V3.dot(pb, w), V3.dot(pb, u));
    });
    return { idx, n };
  });
}
function unitVerts(vs) {
  const r = Math.max(...vs.map(V3.len));
  return vs.map((v) => V3.scale(v, 1 / r));
}
const SHAPES = (() => {
  const s = {};
  const corners = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) corners.push([x, y, z]);
  const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const ico = [];
  for (const a of [-1, 1]) for (const b of [-PHI, PHI]) ico.push([0, a, b], [a, b, 0], [b, 0, a]);
  const dod = corners.slice();
  for (const a of [-1 / PHI, 1 / PHI]) for (const b of [-PHI, PHI]) dod.push([0, a, b], [a, b, 0], [b, 0, a]);
  const d4v = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  s[4] = { verts: unitVerts(d4v), faces: polyFaces(unitVerts(d4v), d4v.map((v) => V3.scale(v, -1))) };
  s[6] = { verts: unitVerts(corners), faces: polyFaces(unitVerts(corners), axes) };
  s[8] = { verts: unitVerts(axes), faces: polyFaces(unitVerts(axes), corners) };
  // Face directions of a convex solid: planes through 3 corners with every corner on one side
  const hullNormals = (verts) => {
    const out = [];
    const n = verts.length;
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) for (let c = b + 1; c < n; c++) {
      let nn = V3.cross(V3.sub(verts[b], verts[a]), V3.sub(verts[c], verts[a]));
      if (V3.len(nn) < 1e-9) continue;
      nn = V3.norm(nn);
      const d = V3.dot(nn, verts[a]);
      if (d < 0) { nn = V3.scale(nn, -1); }
      const dd = Math.abs(d);
      if (verts.some((v) => V3.dot(nn, v) > dd + 1e-6)) continue;
      if (!out.some((m) => V3.dot(m, nn) > 1 - 1e-6)) out.push(nn);
    }
    return out;
  };
  const dodU = unitVerts(dod);
  const icoU = unitVerts(ico);
  s[12] = { verts: dodU, faces: polyFaces(dodU, hullNormals(dodU)) };
  s[20] = { verts: icoU, faces: polyFaces(icoU, hullNormals(icoU)) };
  // d10: pentagonal trapezohedron (kites around a top and bottom point)
  const ring = [];
  for (let k = 0; k < 10; k++) {
    const a = (k * Math.PI) / 5;
    ring.push([Math.cos(a), Math.sin(a), k % 2 ? -0.105 : 0.105]);
  }
  const d10v = unitVerts([[0, 0, 1], [0, 0, -1]].concat(ring));
  const faces10 = [];
  for (let i = 0; i < 5; i++) {
    faces10.push([0, 2 + 2 * i, 2 + ((2 * i + 1) % 10), 2 + ((2 * i + 2) % 10)]);
    faces10.push([1, 2 + ((2 * i + 1) % 10), 2 + ((2 * i + 2) % 10), 2 + ((2 * i + 3) % 10)]);
  }
  s[10] = {
    verts: d10v,
    faces: faces10.map((idx) => {
      const p = idx.map((i) => d10v[i]);
      let n = V3.norm(V3.cross(V3.sub(p[1], p[0]), V3.sub(p[2], p[0])));
      const c = V3.scale(p.reduce((a, v) => [a[0] + v[0], a[1] + v[1], a[2] + v[2]], [0, 0, 0]), 0.25);
      if (V3.dot(n, c) < 0) {
        n = V3.scale(n, -1);
        idx = idx.slice().reverse();
      }
      return { idx, n };
    }),
  };
  return s;
})();

/** What the tray draws for one rolled die (d100 = a tens die and a units die). */
function visualDice(r) {
  const out = [];
  for (const g of r.groups) {
    g.values.forEach((v, i) => {
      const dropped = !g.kept[i];
      if (g.sides === 100) {
        const tens = Math.floor((v % 100) / 10);
        out.push({ shape: 10, labels: ["00", "10", "20", "30", "40", "50", "60", "70", "80", "90"], face: tens, dropped });
        out.push({ shape: 10, labels: ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"], face: v % 10, dropped });
      } else if (SHAPES[g.sides]) {
        const labels = Array.from({ length: g.sides }, (x, k) => String(k + 1));
        out.push({ shape: g.sides, labels, face: v - 1, dropped });
      } else out.push({ shape: 20, labels: Array.from({ length: 20 }, () => String(v)), face: 0, dropped, odd: g.sides });
    });
  }
  return out.slice(0, 14);
}

/** Dice that bounce around inside a canvas and land on the rolled faces. */
class DiceStage {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.dice = [];
    this.raf = 0;
    this.w = 0;
    this.h = 0;
  }
  resize(w, h) {
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(10, w);
    this.h = Math.max(10, h);
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const d of this.dice) {
      d.x = Math.min(Math.max(d.x, d.R), this.w - d.R);
      d.y = Math.min(Math.max(d.y, d.R), this.h - d.R);
    }
    if (!this.raf) this.draw(1);
  }
  colors() {
    const cs = getComputedStyle(this.canvas);
    const accent = cs.getPropertyValue("--interactive-accent").trim() || "#7c3aed";
    const tmp = document.createElement("span");
    tmp.style.color = accent;
    this.canvas.parentElement.appendChild(tmp);
    const rgb = getComputedStyle(tmp).color.match(/\d+(\.\d+)?/g) || [124, 58, 237];
    tmp.remove();
    return { base: rgb.slice(0, 3).map(Number) };
  }
  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  clear() {
    this.stop();
    this.dice = [];
    this.ctx.clearRect(0, 0, this.w, this.h);
  }
  /** Animate `list` (from visualDice); resolves when they've landed. */
  play(list, ms = 1500) {
    this.stop();
    this.col = this.colors();
    const n = list.length;
    const R = Math.max(16, Math.min(44, Math.min(this.w, this.h) * (n > 6 ? 0.085 : 0.11)));
    this.dice = list.map((v, i) => {
      const shape = SHAPES[v.shape];
      const target = shape.faces[Math.max(0, Math.min(shape.faces.length - 1, v.face))].n;
      // land on the rolled face, turned a little towards the viewer so the sides show
      const tilt = Q.axis([0.6 + Math.random() * 0.4, -0.5 - Math.random() * 0.3, 0], 0.32 + Math.random() * 0.12);
      const qT = Q.mul(tilt, Q.mul(Q.axis([0, 0, 1], Math.random() * Math.PI * 2), Q.between(target, [0, 0, 1])));
      const fromLeft = Math.random() < 0.5;
      return {
        ...v,
        R,
        x: fromLeft ? R + 2 : this.w - R - 2,
        y: R + Math.random() * Math.max(1, this.h - 2 * R),
        vx: (fromLeft ? 1 : -1) * (this.w * (0.9 + Math.random() * 0.8)),
        vy: (Math.random() - 0.5) * this.h * 1.6,
        z: 1.2 + i * 0.15,
        vz: 0,
        q: Q.norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]),
        w: V3.scale(V3.norm([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]), 12 + Math.random() * 10),
        qT,
      };
    });
    const start = performance.now();
    let last = start;
    return new Promise((resolve) => {
      const step = (now) => {
        const dt = Math.min(0.05, (now - last) / 1000);
        last = now;
        const t = Math.min(1, (now - start) / ms);
        this.physics(dt, t);
        this.draw(t);
        if (t < 1) this.raf = requestAnimationFrame(step);
        else {
          this.raf = 0;
          resolve();
        }
      };
      this.raf = requestAnimationFrame(step);
    });
  }
  physics(dt, t) {
    const damp = Math.exp(-2.4 * dt);
    for (const d of this.dice) {
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.vx *= damp;
      d.vy *= damp;
      if (d.x < d.R) { d.x = d.R; d.vx = Math.abs(d.vx) * 0.7; }
      if (d.x > this.w - d.R) { d.x = this.w - d.R; d.vx = -Math.abs(d.vx) * 0.7; }
      if (d.y < d.R) { d.y = d.R; d.vy = Math.abs(d.vy) * 0.7; }
      if (d.y > this.h - d.R) { d.y = this.h - d.R; d.vy = -Math.abs(d.vy) * 0.7; }
      d.vz -= 14 * dt;
      d.z += d.vz * dt;
      if (d.z < 0) { d.z = 0; d.vz = Math.abs(d.vz) * 0.45; }
      const spin = V3.len(d.w);
      if (spin > 1e-3) d.q = Q.norm(Q.mul(Q.axis(d.w, spin * dt), d.q));
      d.w = V3.scale(d.w, Math.exp(-1.6 * dt));
    }
    for (let i = 0; i < this.dice.length; i++) {
      for (let j = i + 1; j < this.dice.length; j++) {
        const a = this.dice[i];
        const b = this.dice[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const min = (a.R + b.R) * 0.95;
        if (dist < min) {
          const push = (min - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          a.x -= nx * push; a.y -= ny * push;
          b.x += nx * push; b.y += ny * push;
          const rv = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (rv < 0) {
            a.vx += rv * nx * 0.8; a.vy += rv * ny * 0.8;
            b.vx -= rv * nx * 0.8; b.vy -= rv * ny * 0.8;
          }
        }
      }
    }
  }
  draw(t) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    const settle = t < 0.55 ? 0 : Math.min(1, (t - 0.55) / 0.45);
    const ease = settle * settle * (3 - 2 * settle);
    const light = V3.norm([-0.35, 0.55, 1]);
    for (const d of this.dice) {
      const s = 1 + d.z * 0.18;
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.beginPath();
      ctx.ellipse(d.x + 4 + d.z * 6, d.y + d.R * 0.75 + d.z * 6, d.R * 0.85, d.R * 0.32, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const d of this.dice) {
      const q = t >= 1 ? d.qT : ease > 0 ? Q.slerp(d.q, d.qT, ease) : d.q;
      const shape = SHAPES[d.shape];
      const s = d.R * (1 + d.z * 0.18);
      const vs = shape.verts.map((v) => Q.rot(q, v));
      const proj = vs.map((v) => [d.x + v[0] * s, d.y - v[1] * s]);
      const faces = shape.faces
        .map((f, fi) => ({ f, fi, n: Q.rot(q, f.n), z: f.idx.reduce((a, i) => a + vs[i][2], 0) / f.idx.length }))
        .filter((x) => x.n[2] > 0.02)
        .sort((a, b) => a.z - b.z);
      const [r, g, b] = this.col.base;
      ctx.globalAlpha = t >= 1 && d.dropped ? 0.4 : 1;
      for (const x of faces) {
        const lit = 0.45 + 0.55 * Math.max(0, V3.dot(x.n, light));
        ctx.beginPath();
        x.f.idx.forEach((i, k) => (k ? ctx.lineTo(proj[i][0], proj[i][1]) : ctx.moveTo(proj[i][0], proj[i][1])));
        ctx.closePath();
        ctx.fillStyle = `rgb(${Math.round(r * lit)},${Math.round(g * lit)},${Math.round(b * lit)})`;
        ctx.fill();
        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
        if (x.n[2] < 0.35) continue;
        const cx = x.f.idx.reduce((a, i) => a + proj[i][0], 0) / x.f.idx.length;
        const cy = x.f.idx.reduce((a, i) => a + proj[i][1], 0) / x.f.idx.length;
        const label = d.labels[x.fi] ?? "";
        const fs = s * (d.shape >= 12 ? 0.42 : d.shape === 10 ? 0.4 : 0.55) * (label.length > 2 ? 0.75 : 1) * (0.55 + 0.45 * x.n[2]);
        ctx.font = `700 ${fs.toFixed(1)}px var(--font-interface, sans-serif)`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = `rgba(255,255,255,${(0.35 + 0.65 * x.n[2]).toFixed(2)})`;
        const txt = (label === "6" || label === "9") && d.shape > 8 ? label + "." : label;
        ctx.fillText(txt, cx, cy);
      }
      ctx.globalAlpha = 1;
    }
  }
}

/** "Damage: Bludgeoning, Warhammer" / "Attack: Warhammer" / "Healing: Cure Wounds". */
function rollWhat(r) {
  if (r && r.what) return r.what;
  if (!r || !r.kind) return "";
  const rest = [r.damageType, r.action].filter(Boolean).join(", ");
  return rest ? `${r.kind}: ${rest}` : r.kind;
}

/**
 * Who rolled and what for, read from around a clicked Dice Roller button:
 * the character sheet's Actions/Spells rows (action name, hit cell or
 * damage cell, damage type) or a statblock action. `noteOf(el)` finds the
 * note the button sits in. Returns { who, whoPath, action, kind, damageType }.
 */
function rollContext(el, noteOf) {
  const clean = (x) => String(x || "").replace(/\s+/g, " ").replace(/[.:]\s*$/, "").trim();
  const ctx = { who: null, whoPath: null, action: null, kind: null, damageType: null };
  const formula = String(el.getAttribute("data-dice") || "").toLowerCase();
  const isD20 = /(^|[^\d])1?d20/.test(formula);
  // Character sheet rows: name · range · hit · damage (+ type)
  const cell = el.closest(".dice-roll-cell");
  if (cell) {
    let row = cell.parentElement;
    while (row && !row.querySelector(".action-name") && row.parentElement && row !== document.body && row.querySelectorAll(".dice-roll-cell").length < 2) row = row.parentElement;
    if (row) {
      const cells = Array.from(row.querySelectorAll(".dice-roll-cell"));
      const idx = cells.indexOf(cell);
      const nameEl = row.querySelector(".action-name") || row.querySelector("a.internal-link") || row.firstElementChild;
      if (nameEl && !nameEl.contains(el)) ctx.action = clean(nameEl.textContent).replace(/\s*↑$/, "");
      const own = clean((cell.textContent || "").replace(el.textContent || "", ""));
      if (idx === 0 && isD20) ctx.kind = "Attack";
      else {
        const types = Array.from(row.querySelectorAll(".action-stat > b")).map((b) => clean(b.textContent)).filter(Boolean);
        ctx.damageType = own || (types.length ? types[types.length - 1] : null);
        ctx.kind = /heal|léč/i.test(ctx.damageType || "") ? "Healing" : isD20 ? "Roll" : "Damage";
        if (ctx.kind === "Healing") ctx.damageType = null;
      }
    }
  }
  // Statblock (Fantasy Statblocks): monster name + action name + "… Piercing damage"
  const sb = el.closest(".statblock");
  if (sb) {
    const nm = sb.querySelector(".name, .statblock-name, .heading h1, h1");
    if (nm) ctx.who = clean(nm.textContent);
    const prop = el.closest(".property, .statblock-item-container, li");
    const pn = prop && prop.querySelector(".property-name, strong, b");
    if (pn && !pn.contains(el)) ctx.action = clean(pn.textContent);
    if (!ctx.kind) {
      let after = "";
      for (let n = el.nextSibling; n && after.length < 60; n = n.nextSibling) after += n.textContent || "";
      const dm = /^\)?\s*([A-Za-zÀ-ž]+)\s+damage/i.exec(after.trim());
      if (isD20) ctx.kind = "Attack";
      else if (dm) { ctx.kind = "Damage"; ctx.damageType = dm[1]; }
      else if (/hit point|heal/i.test(after)) ctx.kind = "Healing";
      else ctx.kind = "Damage";
    }
  }
  if (!ctx.who && noteOf) {
    const n = noteOf(el);
    if (n) { ctx.who = n.name; ctx.whoPath = n.path; }
  }
  return ctx;
}

/** A readable name for a roll button: the table row's first cell, a statblock action name, or the formula. */
function guessRollLabel(el) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").replace(/[.:]\s*$/, "").trim().slice(0, 48);
  const row = el.closest("tr");
  if (row) {
    const first = row.querySelector("td, th");
    if (first && !first.contains(el) && clean(first.textContent)) return clean(first.textContent);
  }
  const block = el.closest(".property, .statblock-item-container, li, p, .callout-content > div");
  if (block) {
    const name = block.querySelector(".property-name, strong, b, em");
    if (name && !name.contains(el) && clean(name.textContent)) return clean(name.textContent);
  }
  const f = el.getAttribute("data-dice") || el.textContent;
  return clean(f).replace(/^dice:\s*/i, "");
}

/** Plays a handful of dice on a tray's own canvas (used when Dice Roller isn't installed). */
class DiceStageRunner {
  constructor(tray) {
    this.tray = tray;
  }
  async play(vals, sides) {
    const r = { groups: [{ sides, sign: 1, values: vals, kept: vals.map(() => true) }] };
    if (this.tray.stage) await this.tray.stage.play(visualDice(r));
  }
}

/**
 * Phone layouts inside narrow popups and tiles. Notes like the character
 * sheet switch to their phone layout with @media (max-width: …) - which
 * looks at the whole window, not the popup. This copies those rules, for
 * the cssclasses of notes shown on the screen, into @container rules that
 * look at the popup/tile width instead. Rules aimed at things outside the
 * note (e.g. a menu overlay on <body>) apply while a narrow note is shown.
 */
class ResponsiveNotes {
  constructor(plugin) {
    this.plugin = plugin;
    this.classes = new Set();
    this.styleEl = null;
    this.hosts = new Set();
    this.breakpoint = 0;
    this.ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => this.updateNarrow()) : null;
    this.rebuildSoon = debounce(() => this.rebuild(), 200, true);
  }
  watch(host, classes, comp) {
    let added = false;
    for (const c of classes) {
      if (!this.classes.has(c)) {
        this.classes.add(c);
        added = true;
      }
    }
    if (added || !this.styleEl) this.rebuild();
    this.hosts.add(host);
    if (this.ro) this.ro.observe(host);
    comp.register(() => {
      this.hosts.delete(host);
      if (this.ro) this.ro.unobserve(host);
      this.updateNarrow();
    });
    this.updateNarrow();
  }
  updateNarrow() {
    const bp = this.breakpoint;
    let narrow = false;
    if (bp) for (const h of this.hosts) if (h.isConnected && h.clientWidth > 0 && h.clientWidth <= bp) narrow = true;
    document.body.toggleClass("gms-narrow-note", narrow);
  }
  rebuild() {
    if (!this.classes.size) return;
    const want = [...this.classes].map((c) => `.${c}`);
    const hit = (sel) => want.some((w) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?![\\w-])").test(sel));
    const out = [];
    let bp = 0;
    for (const sheet of Array.from(document.styleSheets)) {
      if (this.styleEl && sheet.ownerNode === this.styleEl) continue;
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const rule of Array.from(rules || [])) {
        if (!(rule.type === 4 || (typeof CSSMediaRule !== "undefined" && rule instanceof CSSMediaRule))) continue;
        const m = /^\(\s*max-width\s*:\s*(\d+)px\s*\)$/i.exec(String(rule.conditionText || (rule.media && rule.media.mediaText) || "").trim());
        if (!m) continue;
        const w = parseInt(m[1], 10);
        const inside = [];
        const outside = [];
        for (const r of Array.from(rule.cssRules || [])) {
          if (!r.selectorText || !r.style) continue;
          const decl = r.style.cssText;
          if (hit(r.selectorText)) inside.push(`${r.selectorText} { ${decl} }`);
          else if (this.relatedOutside(r.selectorText, rule)) {
            const sel = r.selectorText.split(",").map((x) => `body.gms-narrow-note ${x.trim()}`).join(", ");
            outside.push(`${sel} { ${decl} }`);
          }
        }
        if (inside.length) {
          bp = Math.max(bp, w);
          out.push(`@container gms-note (max-width: ${w}px) {\n${inside.join("\n")}\n}`);
          out.push(...outside);
        }
      }
    }
    this.breakpoint = bp;
    if (!this.styleEl) this.styleEl = document.head.createEl("style", { attr: { id: "gms-responsive-notes" } });
    this.styleEl.textContent = out.join("\n");
    this.updateNarrow();
  }
  /** A rule in the same phone block that styles something attached outside the note (no note class in it). */
  relatedOutside(selectorText, mediaRule) {
    return !/\.(workspace|app-container|titlebar|status-bar|mod-|is-mobile|is-phone|side-dock|view-header|nav-)/.test(selectorText) && /^\s*\.[\w-]+/.test(selectorText) && Array.from(mediaRule.cssRules || []).some((r) => r.selectorText && r !== this && this.classes.size && [...this.classes].some((c) => r.selectorText.includes(`.${c}`)));
  }
  destroy() {
    if (this.ro) this.ro.disconnect();
    if (this.styleEl) this.styleEl.remove();
    document.body.removeClass("gms-narrow-note");
  }
}

/** The result card: always bottom-right of the Obsidian window, whether the tray is open or not. */
class RollCards {
  constructor() {
    this.stack = null;
  }
  ensure() {
    if (this.stack && this.stack.isConnected) return this.stack;
    this.stack = document.body.createDiv({ cls: "gms-roll-stack" });
    return this.stack;
  }
  /** `opts.apply`: optional { label, run } – a button on the card (e.g. "Apply…" a damage roll). */
  show(r, opts = {}) {
    const stack = this.ensure();
    const card = stack.createDiv({ cls: "gms-roll-card" });
    const crit = critOf(r);
    if (crit) card.addClass(crit === "crit" ? "is-crit" : "is-fumble");
    const top = card.createDiv({ cls: "gms-roll-card-top" });
    top.createDiv({ cls: "gms-roll-card-label", text: r.who || r.label });
    if (crit) top.createDiv({ cls: "gms-roll-card-flag", text: crit === "crit" ? "Natural 20" : "Natural 1" });
    card.createDiv({ cls: "gms-roll-card-total", text: String(r.total) });
    const bd = card.createDiv({ cls: "gms-roll-card-detail", text: breakdown(r) });
    if (r.label !== r.formula) bd.setAttribute("aria-label", r.formula);
    const what = rollWhat(r);
    if (what) card.createDiv({ cls: "gms-roll-card-what", text: what });
    if (r.outcome) card.addClass(r.outcome === "pass" ? "is-pass" : "is-fail");
    if (opts.apply) {
      const b = card.createEl("button", { cls: "gms-roll-card-apply", text: opts.apply.label });
      b.onclick = (e) => {
        e.stopPropagation();
        opts.apply.run();
        card.remove();
      };
    }
    while (stack.childElementCount > 3) stack.firstElementChild.remove();
    let timer = 0;
    const arm = () => (timer = window.setTimeout(() => card.addClass("is-leaving"), opts.apply ? 12000 : 7000));
    card.addEventListener("mouseenter", () => window.clearTimeout(timer));
    card.addEventListener("mouseleave", arm);
    card.addEventListener("click", () => card.remove());
    card.addEventListener("transitionend", () => { if (card.hasClass("is-leaving")) card.remove(); });
    arm();
    return card;
  }
  /** "Echo is concentrating – DC 12" with a button to roll the save. */
  showConcentration({ name, damage, dc, mod, roll }) {
    const stack = this.ensure();
    const card = stack.createDiv({ cls: "gms-roll-card is-conc" });
    const top = card.createDiv({ cls: "gms-roll-card-top" });
    top.createDiv({ cls: "gms-roll-card-label", text: name });
    top.createDiv({ cls: "gms-roll-card-flag", text: "Concentration" });
    card.createDiv({ cls: "gms-roll-card-total", text: `DC ${dc}` });
    card.createDiv({ cls: "gms-roll-card-detail", text: `Took ${damage} damage · Constitution save` });
    const b = card.createEl("button", { cls: "gms-roll-card-apply mod-cta", text: `Roll CON save (${mod >= 0 ? "+" : ""}${mod})` });
    b.onclick = (e) => {
      e.stopPropagation();
      card.remove();
      roll();
    };
    while (stack.childElementCount > 3) stack.firstElementChild.remove();
    let timer = 0;
    const arm = () => (timer = window.setTimeout(() => card.addClass("is-leaving"), 30000));
    card.addEventListener("mouseenter", () => window.clearTimeout(timer));
    card.addEventListener("mouseleave", arm);
    card.addEventListener("click", () => card.remove());
    card.addEventListener("transitionend", () => { if (card.hasClass("is-leaving")) card.remove(); });
    arm();
    return card;
  }
  /** One card for a batch (e.g. initiative for the whole fight): rows of { label, total, detail, crit }. */
  showList(title, rows) {
    const stack = this.ensure();
    const card = stack.createDiv({ cls: "gms-roll-card is-list" });
    card.createDiv({ cls: "gms-roll-card-top" }).createDiv({ cls: "gms-roll-card-label", text: title });
    const list = card.createDiv({ cls: "gms-roll-card-list" });
    for (const r of rows) {
      const row = list.createDiv({ cls: "gms-roll-card-row" });
      if (r.crit) row.addClass(r.crit === "crit" ? "is-crit" : "is-fumble");
      row.createSpan({ cls: "gms-roll-card-row-label", text: r.label });
      if (r.detail) row.createSpan({ cls: "gms-roll-card-row-detail", text: r.detail });
      row.createSpan({ cls: "gms-roll-card-row-total", text: String(r.total) });
    }
    while (stack.childElementCount > 3) stack.firstElementChild.remove();
    let timer = 0;
    const arm = () => (timer = window.setTimeout(() => card.addClass("is-leaving"), 12000));
    card.addEventListener("mouseenter", () => window.clearTimeout(timer));
    card.addEventListener("mouseleave", arm);
    card.addEventListener("click", () => card.remove());
    card.addEventListener("transitionend", () => { if (card.hasClass("is-leaving")) card.remove(); });
    arm();
    return card;
  }
  destroy() {
    if (this.stack) this.stack.remove();
    this.stack = null;
  }
}

/* ------------------------------------------------------------------ */
/* Small dialogs                                                       */
/* ------------------------------------------------------------------ */

class TextPrompt extends Modal {
  constructor(app, title, value, onSubmit, cta = "Save") {
    super(app);
    this.titleText = title;
    this.value = value || "";
    this.onSubmit = onSubmit;
    this.cta = cta;
  }
  onOpen() {
    this.titleEl.setText(this.titleText);
    const input = this.contentEl.createEl("input", { type: "text", cls: "gms-prompt-input", value: this.value });
    const done = () => {
      const v = input.value.trim();
      this.close();
      if (v) this.onSubmit(v);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); done(); } });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: this.cta, cls: "mod-cta" }).onclick = done;
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }
  onClose() { this.contentEl.empty(); }
}

class ConfirmPrompt extends Modal {
  constructor(app, title, text, onYes, cta = "Delete") {
    super(app);
    this.t = title;
    this.text = text;
    this.onYes = onYes;
    this.cta = cta;
  }
  onOpen() {
    this.titleEl.setText(this.t);
    this.contentEl.createEl("p", { text: this.text });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: this.cta, cls: "mod-warning" }).onclick = () => { this.close(); this.onYes(); };
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

class NewSessionModal extends Modal {
  constructor(plugin, notes) {
    super(plugin.app);
    this.plugin = plugin;
    this.notes = notes || "";
  }
  onOpen() {
    const d = this.plugin.settings.diary;
    this.titleEl.setText("New session");
    const vals = { number: this.plugin.nextSessionNumber(), title: "", date: moment().format("YYYY-MM-DD") };
    const preview = this.contentEl.createDiv({ cls: "gms-session-preview" });
    const update = () => {
      const name = this.plugin.sessionFileName(vals);
      preview.setText(`${(d.folder || "").replace(/\/+$/, "") || "(vault root)"}/${name}.md`);
    };
    new Setting(this.contentEl).setName("Session number").addText((t) => {
      t.inputEl.type = "number";
      t.setValue(String(vals.number)).onChange((v) => { vals.number = parseInt(v, 10) || 0; update(); });
    });
    let titleInput;
    new Setting(this.contentEl).setName("Title").addText((t) => {
      titleInput = t.inputEl;
      t.setPlaceholder("The long road").onChange((v) => { vals.title = v.trim(); update(); });
    });
    new Setting(this.contentEl).setName("Date").addText((t) => {
      t.inputEl.type = "date";
      t.setValue(vals.date).onChange((v) => { vals.date = v; update(); });
    });
    update();
    if (this.notes.trim()) {
      const lines = this.notes.trim().split("\n").length;
      this.contentEl.createDiv({ cls: "setting-item-description", text: `Your notes (${lines} line${lines === 1 ? "" : "s"}) go into the new note, and the draft is cleared.` });
    }
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    const go = async () => {
      this.close();
      await this.plugin.createSession(vals, this.notes);
    };
    row.createEl("button", { text: "Create", cls: "mod-cta" }).onclick = go;
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    titleInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    setTimeout(() => titleInput.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

class ExportScreenModal extends Modal {
  constructor(plugin, sc) {
    super(plugin.app);
    this.plugin = plugin;
    this.sc = sc;
  }
  onOpen() {
    this.titleEl.setText(`Export "${this.sc.name}"`);
    const json = JSON.stringify(screenToJson(this.sc), null, 2);
    this.contentEl.createDiv({ cls: "setting-item-description", text: "Share this with another GM, or keep it as a backup. Notes, maps and characters are linked by their path, so they show up when the other vault has notes with the same names. Sticky notes and checklists travel with their text." });
    const ta = this.contentEl.createEl("textarea", { cls: "gms-json-box", attr: { readonly: "true", spellcheck: "false" } });
    ta.value = json;
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Copy", cls: "mod-cta" }).onclick = async () => {
      try {
        await navigator.clipboard.writeText(json);
        new Notice("Screen copied.");
      } catch (e) {
        ta.select();
        new Notice("Select the text and copy it.");
      }
    };
    row.createEl("button", { text: "Save as file in the vault" }).onclick = async () => {
      const name = `${cleanFileName(this.sc.name) || "Screen"}.gmscreen.json`;
      let path = normalizePath(name);
      for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(name.replace(/\.gmscreen\.json$/, ` ${n}.gmscreen.json`));
      await this.app.vault.create(path, json);
      new Notice(`Saved ${path}`);
      this.close();
    };
    row.createEl("button", { text: "Close" }).onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

class JsonFilePicker extends FuzzySuggestModal {
  constructor(plugin, onPick) {
    super(plugin.app);
    this.onPick = onPick;
    this.setPlaceholder("Pick an exported screen (.json)");
  }
  getItems() { return this.app.vault.getFiles().filter((f) => f.extension === "json" && !f.path.startsWith(this.app.vault.configDir)); }
  getItemText(f) { return f.path; }
  onChooseItem(f) { this.onPick(f); }
}

class ImportScreenModal extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
  }
  onOpen() {
    this.titleEl.setText("Import screen");
    this.contentEl.createDiv({ cls: "setting-item-description", text: "Paste an exported screen, or load a .json file from the vault." });
    const ta = this.contentEl.createEl("textarea", { cls: "gms-json-box", attr: { spellcheck: "false", placeholder: '{ "gmScreen": 1, "name": "...", "tiles": [...] }' } });
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Import", cls: "mod-cta" }).onclick = async () => {
      const data = screenFromJson(ta.value);
      if (!data) return new Notice("That isn't an exported screen.");
      this.close();
      await this.plugin.addScreenFrom(data);
    };
    row.createEl("button", { text: "Load file…" }).onclick = () => new JsonFilePicker(this.plugin, async (f) => { ta.value = await this.app.vault.read(f); }).open();
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    setTimeout(() => ta.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

class CombatBuilder extends Modal {
  constructor(plugin) {
    super(plugin.app);
    this.plugin = plugin;
    this.name = "";
    this.sources = plugin.partySources();
    this.players = this.sources.length ? this.sources[0].files.slice() : [];
    this.creatures = [];
  }
  onOpen() {
    this.modalEl.addClass("gms-combat-modal");
    this.titleEl.setText("New combat");
    const c = this.contentEl;
    const ri = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["roll-initiative"];
    if (!ri) c.createDiv({ cls: "gms-warn", text: "Roll for Initiative isn't enabled. The encounter note is still created, but the tracker needs that plugin." });

    let nameInput;
    new Setting(c).setName("Encounter name").addText((t) => {
      nameInput = t.inputEl;
      t.setPlaceholder("Ambush at the docks").onChange((v) => { this.name = v.trim(); this.updatePath(); });
    });

    c.createDiv({ cls: "gms-cb-title", text: "Party" });
    const pbar = c.createDiv({ cls: "gms-cb-partybar" });
    const pick = pbar.createEl("select", { cls: "dropdown gms-cb-source" });
    pick.createEl("option", { value: "", text: this.sources.length ? "Start from a party…" : "No parties yet" });
    this.sources.forEach((src, i) => pick.createEl("option", { value: String(i), text: `${src.label} (${src.files.length})` }));
    pick.value = this.sources.length ? "0" : "";
    pick.onchange = () => {
      const src = this.sources[Number(pick.value)];
      if (!src) return;
      this.players = src.files.slice();
      this.renderPlayers();
    };
    const addPc = pbar.createEl("button", { cls: "gms-cb-addpc" });
    setIcon(addPc.createSpan(), "user-plus");
    addPc.createSpan({ text: "Add character" });
    addPc.onclick = () => new CharacterPicker(this.plugin, this.players.map((f) => f.path), (f) => {
      this.players.push(f);
      this.renderPlayers();
    }, "Add a character to this combat").open();
    const clear = pbar.createEl("button", { text: "Clear" });
    clear.onclick = () => {
      this.players = [];
      pick.value = "";
      this.renderPlayers();
    };
    this.partyEl = c.createDiv({ cls: "gms-cb-party" });
    this.renderPlayers();

    c.createDiv({ cls: "gms-cb-title", text: "Creatures" });
    const search = c.createDiv({ cls: "gms-cb-search" });
    const input = search.createEl("input", { type: "search", attr: { placeholder: "Search monsters and NPCs to add…" } });
    const sugg = search.createDiv({ cls: "gms-cb-sugg gms-hidden" });
    const cats = this.plugin.settings.categories || [];
    const monsterCat = cats.find((x) => /monst|příšer|prisera|creature|bestiar/i.test(x.name));
    const showSugg = () => {
      sugg.empty();
      const q = input.value.trim();
      if (!q) return sugg.addClass("gms-hidden");
      let res = this.plugin.index.query(q, monsterCat || null, 8);
      if (!res.length && monsterCat) res = this.plugin.index.query(q, null, 8);
      sugg.removeClass("gms-hidden");
      if (!res.length) sugg.createDiv({ cls: "gms-empty", text: "No matches. Use “Add custom” for a creature without a note." });
      for (const r of res) {
        const row = sugg.createDiv({ cls: "gms-cb-sugg-row", text: r.file.basename });
        row.createSpan({ cls: "gms-cb-sugg-path", text: r.file.parent ? r.file.parent.path.split("/").pop() : "" });
        row.onclick = () => {
          const have = this.creatures.find((x) => x.file === r.file);
          if (have) have.count++;
          else this.creatures.push({ file: r.file, name: r.file.basename, count: 1, side: "enemy" });
          input.value = "";
          sugg.addClass("gms-hidden");
          this.renderCreatures();
          input.focus();
        };
      }
    };
    input.addEventListener("input", showSugg);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const first = sugg.querySelector(".gms-cb-sugg-row");
        if (first) first.click();
      }
    });
    const custom = search.createEl("button", { text: "Add custom" });
    custom.onclick = () => {
      this.creatures.push({ name: input.value.trim() || "Creature", count: 1, side: "enemy", hp: "", ac: "" });
      input.value = "";
      sugg.addClass("gms-hidden");
      this.renderCreatures();
    };
    this.list = c.createDiv({ cls: "gms-cb-list" });
    this.renderCreatures();

    this.pathEl = c.createDiv({ cls: "gms-session-preview" });
    this.updatePath();
    const row = c.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Create & pin to screen", cls: "mod-cta" }).onclick = () => this.create();
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    setTimeout(() => nameInput.focus(), 0);
  }
  renderPlayers() {
    const el = this.partyEl;
    el.empty();
    if (!this.players.length) {
      el.createDiv({ cls: "gms-empty", text: "No characters in this combat. Pick a party above or add characters one by one." });
      return;
    }
    this.players.forEach((f, i) => {
      const chip = el.createDiv({ cls: "gms-cb-chip" });
      chip.createSpan({ text: f.basename });
      const x = chip.createEl("button", { cls: "clickable-icon gms-icon-btn", attr: { "aria-label": `Leave ${f.basename} out` } });
      setIcon(x, "x");
      x.onclick = () => {
        this.players.splice(i, 1);
        this.renderPlayers();
      };
    });
  }
  updatePath() {
    const folder = String(this.plugin.settings.combat.folder || "").replace(/\/+$/, "");
    const name = cleanFileName(this.name) || "Encounter";
    this.pathEl && this.pathEl.setText(`Saved as ${folder ? folder + "/" : ""}${name}.md`);
  }
  renderCreatures() {
    const el = this.list;
    el.empty();
    if (!this.creatures.length) {
      el.createDiv({ cls: "gms-empty", text: "No creatures yet." });
      return;
    }
    this.creatures.forEach((cr, i) => {
      const row = el.createDiv({ cls: "gms-cb-row" });
      if (cr.file) row.createSpan({ cls: "gms-cb-name", text: cr.name });
      else {
        const n = row.createEl("input", { type: "text", cls: "gms-cb-name-input", value: cr.name });
        n.oninput = () => (cr.name = n.value);
        const hp = row.createEl("input", { type: "number", cls: "gms-cb-num", attr: { placeholder: "HP" }, value: cr.hp });
        hp.oninput = () => (cr.hp = hp.value);
        const ac = row.createEl("input", { type: "number", cls: "gms-cb-num", attr: { placeholder: "AC" }, value: cr.ac });
        ac.oninput = () => (cr.ac = ac.value);
      }
      const cnt = row.createEl("input", { type: "number", cls: "gms-cb-num", value: String(cr.count), attr: { min: "1", max: "50", "aria-label": "How many" } });
      cnt.oninput = () => (cr.count = Math.max(1, parseInt(cnt.value, 10) || 1));
      const side = row.createEl("select", { cls: "dropdown gms-cb-side" });
      for (const [v, l] of [["enemy", "Enemy"], ["ally", "Ally"], ["neutral", "Neutral"]]) side.createEl("option", { value: v, text: l });
      side.value = cr.side;
      side.onchange = () => (cr.side = side.value);
      const x = row.createEl("button", { cls: "clickable-icon gms-icon-btn", attr: { "aria-label": "Remove" } });
      setIcon(x, "x");
      x.onclick = () => {
        this.creatures.splice(i, 1);
        this.renderCreatures();
      };
    });
  }
  async create() {
    const players = this.players.slice();
    if (!players.length && !this.creatures.length) return new Notice("Add the party or some creatures first.");
    this.close();
    const name = this.name || `Encounter ${moment().format("YYYY-MM-DD HH-mm")}`;
    await this.plugin.createCombat({ name, players, creatures: this.creatures });
  }
  onClose() { this.contentEl.empty(); }
}

/* ------------------------------------------------------------------ */
/* The screen view                                                     */
/* ------------------------------------------------------------------ */

class GmScreenView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.query = "";
    this.category = null;
    this.results = [];
    this.selected = -1;
    this.searchToken = 0;
    this.tileComps = [];
    this.popups = [];
    this.watch = new Set();
    this.z = 1;
    this.trays = [];
    this.renderPartySoon = debounce(() => this.renderPartyTiles(), 150, true);
    this.runSearchSoon = debounce(() => this.runSearch(), 120, true);
  }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return "Game Master Interactive Screen"; }
  getIcon() { return "shield"; }

  get screen() {
    return this.plugin.activeScreen();
  }

  async onOpen() {
    const root = this.contentEl;
    root.empty();
    root.addClass("gms-root");

    this.tabsEl = root.createDiv({ cls: "gms-tabs" });
    this.toolbar = root.createDiv({ cls: "gms-toolbar" });
    this.buildToolbar(this.toolbar);
    this.combatBar = root.createDiv({ cls: "gms-combat-bar gms-hidden" });
    this.stage = root.createDiv({ cls: "gms-stage" });
    this.boardWrap = this.stage.createDiv({ cls: "gms-board-wrap" });
    this.board = this.boardWrap.createDiv({ cls: "gms-board" });
    this.popupLayer = this.stage.createDiv({ cls: "gms-popup-layer" });

    this.registerDomEvent(root, "keydown", (e) => {
      if (e.key === "Escape" && this.popups.length && e.target !== this.input) {
        this.closePopup(this.popups[this.popups.length - 1]);
        e.preventDefault();
      }
    });
    this.registerDomEvent(document, "pointerdown", (e) => {
      if (!this.searchBox.contains(e.target)) this.hideResults();
    });

    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (this.watch.has(file.path)) this.renderPartySoon();
    }));
    this.registerEvent(this.app.workspace.on("dnd-sheet:main-file-changed", () => this.renderPartySoon()));
    this.registerEvent(this.app.workspace.on("dnd-sheet:conditions-changed", () => this.renderPartySoon()));
    this.renderCombatBar();

    this.refreshAll();
  }

  async onClose() {
    this.unloadTiles();
    [...this.popups].forEach((p) => this.closePopup(p));
  }

  refreshAll() {
    this.renderTabs();
    this.renderCategories();
    this.renderBoard();
  }

  iconBtn(parent, icon, label, fn, cls = "") {
    const b = parent.createEl("button", { cls: `clickable-icon gms-icon-btn ${cls}`.trim(), attr: { "aria-label": label } });
    setIcon(b, icon);
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.onclick = (e) => {
      e.stopPropagation();
      fn(e);
    };
    return b;
  }

  hover(event, targetEl, linktext, sourcePath = "") {
    this.app.workspace.trigger("hover-link", { event, source: VIEW_TYPE, hoverParent: this, targetEl, linktext, sourcePath });
  }

  openFile(file, newTab) {
    this.app.workspace.getLeaf(newTab ? "tab" : false).openFile(file);
  }

  /* ---------------- Combat bar (Roll for Initiative) ---------------- */

  renderCombatBar() {
    const bar = this.combatBar;
    if (!bar) return;
    const st = this.plugin.combatState;
    const ri = this.plugin.ri();
    const show = !!(ri && st && st.running && !st.ended && this.plugin.settings.showCombatBar !== false);
    bar.toggleClass("gms-hidden", !show);
    bar.empty();
    if (!show) return;
    const ic = bar.createSpan({ cls: "gms-cb-icon" });
    setIcon(ic, "swords");
    const name = bar.createEl("a", { cls: "gms-combat-name", text: st.name || "Combat" });
    name.onclick = () => this.openPopup({ type: "combat", path: st.sourcePath, blockId: st.id || undefined, title: st.name || "Combat" });
    bar.createSpan({ cls: "gms-combat-round", text: `Round ${st.round || 1}` });
    const turn = bar.createSpan({ cls: "gms-combat-turn" });
    turn.createSpan({ cls: "gms-combat-k", text: "Turn" });
    turn.createSpan({ cls: "gms-combat-v", text: st.current || "–" });
    if (st.next) {
      const nx = bar.createSpan({ cls: "gms-combat-next" });
      nx.createSpan({ cls: "gms-combat-k", text: "Next" });
      nx.createSpan({ cls: "gms-combat-v", text: st.next });
    }
    const conc = this.plugin.settings.concentration !== false ? (st.combatants || []).filter((c) => (c.conditions || []).some(isConcentration)) : [];
    if (conc.length) {
      const cc = bar.createSpan({ cls: "gms-combat-conc", attr: { "aria-label": "Concentrating" } });
      setIcon(cc.createSpan({ cls: "gms-combat-conc-icon" }), "target");
      cc.createSpan({ text: conc.map((c) => c.name).join(", ") });
    }
    bar.createDiv({ cls: "gms-spacer" });
    const btn = (icon, text, label, fn, cls = "") => {
      const b = bar.createEl("button", { cls: `gms-combat-btn ${cls}`.trim(), attr: { "aria-label": label } });
      setIcon(b.createSpan(), icon);
      if (text) b.createSpan({ text });
      b.onclick = fn;
      return b;
    };
    btn("chevron-left", "", "Previous turn", () => ri.previous());
    btn("chevron-right", "Next turn", "Next turn", () => ri.next(), "mod-cta");
    const tiles = this.screen.tiles;
    if (!tiles.some((t) => t.type === "combat" && t.path === st.sourcePath)) {
      btn("pin", "", "Put this combat on the screen", () => this.plugin.addTile({ type: "combat", path: st.sourcePath, blockId: st.id || undefined, title: st.name || "Combat" }));
    }
    if (typeof ri.showOnPlayerScreen === "function" && this.app.plugins.plugins["ttrpg-tools-screen"]) {
      btn("monitor-up", "", "Show initiative on the player screen", () => ri.showOnPlayerScreen());
    }
    if (typeof ri.endCombat === "function") {
      btn("square", "", "End combat", () => new ConfirmPrompt(this.app, "End combat", `End "${st.name || "this combat"}"?`, () => ri.endCombat({ sourcePath: st.sourcePath, id: st.id }), "End combat").open());
    }
  }

  /* ---------------- Tabs ---------------- */

  renderTabs() {
    const el = this.tabsEl;
    el.empty();
    const s = this.plugin.settings;
    s.screens.forEach((sc, i) => {
      const tab = el.createDiv({ cls: "gms-tab", text: sc.name });
      tab.toggleClass("is-active", sc.id === s.activeScreen);
      tab.onclick = () => this.switchScreen(sc.id);
      tab.ondblclick = () => this.renameScreen(sc);
      tab.oncontextmenu = (e) => {
        e.preventDefault();
        const m = new Menu();
        m.addItem((it) => it.setTitle("Rename").setIcon("pencil").onClick(() => this.renameScreen(sc)));
        m.addItem((it) => it.setTitle("Duplicate").setIcon("copy").onClick(() => this.plugin.duplicateScreen(sc)));
        m.addItem((it) => it.setTitle(sc.locked ? "Unlock layout" : "Lock layout").setIcon(sc.locked ? "lock-open" : "lock").onClick(async () => {
          sc.locked = !sc.locked;
          await this.plugin.saveSettings();
          this.plugin.views().forEach((v) => v.renderBoard());
        }));
        m.addSeparator();
        m.addItem((it) => it.setTitle("Save as template…").setIcon("layout-template").onClick(() =>
          new TextPrompt(this.app, "Save screen as template", sc.name, (name) => this.plugin.saveTemplate(sc, name), "Save").open()));
        m.addItem((it) => it.setTitle("Export…").setIcon("upload").onClick(() => new ExportScreenModal(this.plugin, sc).open()));
        m.addSeparator();
        if (i > 0) m.addItem((it) => it.setTitle("Move left").setIcon("arrow-left").onClick(() => this.plugin.moveScreen(i, -1)));
        if (i < s.screens.length - 1) m.addItem((it) => it.setTitle("Move right").setIcon("arrow-right").onClick(() => this.plugin.moveScreen(i, 1)));
        if (s.screens.length > 1) {
          m.addSeparator();
          m.addItem((it) => it.setTitle("Delete screen").setIcon("trash").onClick(() =>
            new ConfirmPrompt(this.app, "Delete screen", `Delete "${sc.name}" and its ${sc.tiles.length} tiles? The notes themselves are not touched.`, () => this.plugin.deleteScreen(sc.id)).open()));
        }
        m.showAtMouseEvent(e);
      };
    });
    this.iconBtn(el, "plus", "New screen", (e) => {
      const m = new Menu();
      m.addItem((it) => it.setTitle("Empty screen").setIcon("square-dashed").onClick(() =>
        new TextPrompt(this.app, "New screen", `Screen ${s.screens.length + 1}`, (name) => this.plugin.addScreen(name), "Create").open()));
      const tpls = s.templates || [];
      if (tpls.length) {
        m.addSeparator();
        for (const tp of tpls) m.addItem((it) => it.setTitle(`From template: ${tp.name}`).setIcon("layout-template").onClick(() => this.plugin.addScreenFrom({ name: tp.name, tiles: tp.tiles })));
      }
      m.addSeparator();
      m.addItem((it) => it.setTitle("Import screen…").setIcon("download").onClick(() => new ImportScreenModal(this.plugin).open()));
      m.showAtMouseEvent(e);
    }, "gms-tab-add");
  }

  renameScreen(sc) {
    new TextPrompt(this.app, "Rename screen", sc.name, async (name) => {
      sc.name = name;
      await this.plugin.saveSettings();
      this.plugin.views().forEach((v) => v.renderTabs());
    }).open();
  }

  async switchScreen(id) {
    this.plugin.settings.activeScreen = id;
    await this.plugin.saveSettings();
    this.plugin.views().forEach((v) => {
      v.renderTabs();
      v.renderBoard();
    });
  }

  /* ---------------- Toolbar & search ---------------- */

  buildToolbar(el) {
    this.searchBox = el.createDiv({ cls: "gms-search" });
    const row = this.searchBox.createDiv({ cls: "gms-search-row" });
    const icon = row.createSpan({ cls: "gms-search-icon" });
    setIcon(icon, "search");
    this.input = row.createEl("input", { type: "search", cls: "gms-search-input", attr: { placeholder: "Search notes to add…", spellcheck: "false" } });
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.runSearchSoon();
    });
    this.input.addEventListener("focus", () => { if (this.results.length) this.showResults(); });
    this.input.addEventListener("keydown", (e) => this.onSearchKey(e));
    this.resultsEl = this.searchBox.createDiv({ cls: "gms-results gms-hidden" });
    this.catRow = el.createDiv({ cls: "gms-cats" });
    const add = el.createEl("button", { cls: "gms-add-btn" });
    setIcon(add.createSpan(), "plus");
    add.createSpan({ text: "Add" });
    add.onclick = (e) => this.addMenu(e);
    this.lockBtn = el.createEl("button", { cls: "gms-lock-btn" });
    this.lockBtn.onclick = async () => {
      const sc = this.screen;
      sc.locked = !sc.locked;
      await this.plugin.saveSettings();
      this.plugin.views().forEach((v) => v.renderBoard());
    };
  }
  renderLock() {
    if (!this.lockBtn) return;
    const locked = !!this.screen.locked;
    this.lockBtn.empty();
    setIcon(this.lockBtn.createSpan(), locked ? "lock" : "lock-open");
    this.lockBtn.setAttribute("aria-label", locked ? "Layout locked – click to move and resize tiles again" : "Lock this screen's layout (tiles can't be moved or resized)");
    this.lockBtn.toggleClass("is-on", locked);
  }

  addMenu(e) {
    const m = new Menu();
    m.addItem((it) => it.setTitle("Party").setIcon(TILE_ICONS.party).onClick(() => this.plugin.addTile({ type: "party" })));
    m.addItem((it) => it.setTitle("Session notes").setIcon(TILE_ICONS.diary).onClick(() => this.plugin.addTile({ type: "diary" })));
    m.addItem((it) => it.setTitle("Combat…").setIcon(TILE_ICONS.combat).onClick(() => this.plugin.newCombat()));
    m.addItem((it) => it.setTitle("Dice tray").setIcon(TILE_ICONS.dice).onClick(() => this.plugin.addTile({ type: "dice" })));
    m.addItem((it) => it.setTitle("Sticky note").setIcon(TILE_ICONS.sticky).onClick(() => this.plugin.addTile({ type: "sticky" })));
    m.addItem((it) => it.setTitle("Checklist").setIcon(TILE_ICONS.checklist).onClick(() => this.plugin.addTile({ type: "checklist", items: [] })));
    m.showAtMouseEvent(e);
  }

  focusSearch() {
    this.input.focus();
    this.input.select();
  }

  renderCategories() {
    const cats = this.plugin.settings.categories || [];
    this.catRow.empty();
    this.catRow.toggleClass("gms-hidden", !cats.length);
    if (this.category && !cats.some((c) => c.name === this.category)) this.category = null;
    const chip = (label, value) => {
      const b = this.catRow.createEl("button", { cls: "gms-cat", text: label });
      b.toggleClass("is-active", this.category === value);
      b.onclick = () => {
        this.category = this.category === value ? null : value;
        this.renderCategories();
        this.runSearch();
        this.input.focus();
      };
    };
    chip("All", null);
    for (const c of cats) chip(c.name, c.name);
  }

  currentCategory() {
    return (this.plugin.settings.categories || []).find((c) => c.name === this.category) || null;
  }

  showResults() { this.resultsEl.removeClass("gms-hidden"); }
  hideResults() { this.resultsEl.addClass("gms-hidden"); }

  async runSearch() {
    const token = ++this.searchToken;
    const q = this.query.trim();
    const cat = this.currentCategory();
    const limit = Math.max(5, Number(this.plugin.settings.resultLimit) || 30);
    if (!q) {
      this.results = [];
      this.renderResults();
      this.hideResults();
      return;
    }
    this.results = this.plugin.index.query(q, cat, limit);
    this.selected = this.results.length ? 0 : -1;
    this.renderResults();
    this.showResults();
    if (this.plugin.settings.fullText && this.results.length < limit) {
      const skip = new Set(this.results.map((r) => r.file.path));
      const more = await this.plugin.index.fullText(q, cat, limit - this.results.length, skip, () => token !== this.searchToken);
      if (token !== this.searchToken || !more || !more.length) return;
      this.results = this.results.concat(more);
      if (this.selected < 0) this.selected = 0;
      this.renderResults();
    }
  }

  renderResults() {
    const el = this.resultsEl;
    el.empty();
    if (!this.results.length) {
      if (this.query.trim()) el.createDiv({ cls: "gms-empty", text: "No matches." });
      return;
    }
    this.results.forEach((r, i) => {
      const row = el.createDiv({ cls: "gms-result" });
      row.toggleClass("is-selected", i === this.selected);
      const main = row.createDiv({ cls: "gms-result-main" });
      main.createDiv({ cls: "gms-result-title", text: r.file.basename });
      const sub = r.heading ? `# ${r.heading}` : r.snippet ? `…${r.snippet}…` : r.file.parent ? r.file.parent.path : "";
      if (sub && sub !== "/") main.createDiv({ cls: "gms-result-sub", text: sub });
      const acts = row.createDiv({ cls: "gms-result-actions" });
      if (r.heading) this.iconBtn(acts, TILE_ICONS.section, `Add section "${r.heading}" to screen`, () => this.addFromResult(r, true));
      const fightOn = this.plugin.combatState && !this.plugin.combatState.ended && this.plugin.ri() && typeof this.plugin.ri().addCombatant === "function";
      if (fightOn) this.iconBtn(acts, "swords", `Add ${r.file.basename} to the fight`, () => this.plugin.addToFight(r.file), "gms-to-fight");
      this.iconBtn(acts, "plus", "Add note to screen", () => this.addFromResult(r, false));
      this.iconBtn(acts, "file-symlink", "Open note", () => this.openFile(r.file, false));
      row.onclick = (e) => {
        if (e.ctrlKey || e.metaKey) return this.openFile(r.file, true);
        this.selected = i;
        this.renderResults();
        this.openPopup({ type: r.heading ? "section" : "note", path: r.file.path, heading: r.heading || undefined, title: r.file.basename });
      };
      row.addEventListener("mouseover", (e) => this.hover(e, row, r.file.path));
    });
  }

  addFromResult(r, section) {
    if (section && r.heading) this.plugin.addTile({ type: "section", path: r.file.path, heading: r.heading });
    else this.plugin.addTile({ type: "note", path: r.file.path });
  }

  onSearchKey(e) {
    const n = this.results.length;
    if (e.key === "ArrowDown" && n) {
      e.preventDefault();
      this.selected = (this.selected + 1) % n;
      this.renderResults();
      this.showResults();
    } else if (e.key === "ArrowUp" && n) {
      e.preventDefault();
      this.selected = (this.selected - 1 + n) % n;
      this.renderResults();
    } else if (e.key === "Enter" && this.selected >= 0 && n) {
      e.preventDefault();
      const r = this.results[this.selected];
      if (e.altKey || e.shiftKey) this.addFromResult(r, e.shiftKey && !!r.heading);
      else if (e.ctrlKey || e.metaKey) this.openFile(r.file, true);
      else this.openPopup({ type: r.heading ? "section" : "note", path: r.file.path, heading: r.heading || undefined, title: r.file.basename });
    } else if (e.key === "Escape") {
      if (this.resultsEl.hasClass("gms-hidden")) {
        this.input.value = "";
        this.query = "";
      }
      this.hideResults();
    }
    const sel = this.resultsEl.querySelector(".gms-result.is-selected");
    if (sel) sel.scrollIntoView({ block: "nearest" });
  }

  /* ---------------- Content (note / section / map) ---------------- */

  /** Markdown + context for a note, section or map tile. */
  async contentFor(spec) {
    const file = this.app.vault.getAbstractFileByPath(spec.path);
    if (!(file instanceof TFile)) return { error: `Note not found: ${spec.path}` };
    const text = await this.app.vault.cachedRead(file);
    if (spec.type === "combat") {
      const block = findInitiativeBlock(text, spec.blockId);
      if (!block) return { file, error: `This combat is no longer in ${file.basename}.` };
      return { file, md: "```roll-initiative\n" + block.body.join("\n") + "\n```", mapBase: null };
    }
    if (spec.type === "map") {
      const block = pickMap(findMapBlocks(text), spec);
      if (!block) return { file, error: "This map is no longer in the note." };
      return { file, md: mapMarkdown(block, true), mapBase: null };
    }
    if (spec.type === "section" && spec.heading) {
      const sec = extractSection(text, spec.heading, spec.level);
      if (!sec) return { file, error: `Heading "${spec.heading}" not found in ${file.basename}.` };
      const mapBase = findMapBlocks(text).filter((b) => b.start < sec.startLine).length;
      return { file, md: sec.md, mapBase };
    }
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    return { file, md: lines.slice(frontmatterEnd(lines)).join("\n"), mapBase: 0 };
  }

  /**
   * Render a note, section or map into `el`. Links stay inside the screen
   * (`onLink`); headings and maps get "add to screen" buttons when
   * `decorate` is set.
   */
  async renderSpec(spec, host, comp, onLink, decorate) {
    host.empty();
    const c = await this.contentFor(spec);
    if (c.error) {
      host.createDiv({ cls: "gms-empty", text: c.error });
      return c;
    }
    // Same wrapper and cssclasses the note gets in reading view, so sheet/snippet styling applies
    const el = host.createDiv({ cls: spec.type === "map" ? "gms-render is-map-render" : "gms-render markdown-preview-view markdown-rendered", attr: { "data-gms-path": c.file.path } });
    if (spec.type !== "map") {
      // The note's cssclasses, kept live: the character sheet switches tabs / mobile pages by changing them
      let applied = this.noteClasses(c.file);
      applied.forEach((cls) => el.addClass(cls));
      comp.registerEvent(this.app.metadataCache.on("changed", (f) => {
        if (f.path !== c.file.path) return;
        const now = this.noteClasses(c.file);
        applied.filter((x) => !now.includes(x)).forEach((x) => el.removeClass(x));
        now.forEach((x) => el.addClass(x));
        applied = now;
      }));
      // Narrow popups/tiles get the note's phone layout (its max-width media rules, applied by width)
      host.addClass("gms-note-host");
      this.plugin.responsive.watch(host, applied, comp);
    }
    await MarkdownRenderer.render(this.app, c.md, el, c.file.path, comp);
    el.addEventListener("click", (e) => {
      const a = e.target.closest && e.target.closest("a.internal-link");
      if (!a) return;
      e.preventDefault();
      e.stopPropagation();
      const href = a.getAttribute("data-href") || a.getAttribute("href") || "";
      const [p, sub] = href.split("#");
      const target = p ? this.app.metadataCache.getFirstLinkpathDest(p, c.file.path) : c.file;
      if (!(target instanceof TFile)) return;
      if (e.ctrlKey || e.metaKey) this.app.workspace.getLeaf("tab").openFile(target);
      else onLink({ type: sub && !sub.startsWith("^") ? "section" : "note", path: target.path, heading: sub && !sub.startsWith("^") ? sub : undefined, title: target.basename });
    });
    el.addEventListener("mouseover", (e) => {
      const a = e.target.closest && e.target.closest("a.internal-link");
      if (a) this.hover(e, a, a.getAttribute("data-href") || "", c.file.path);
    });
    if (decorate && spec.type !== "map") this.decorate(el, c.file, c.mapBase || 0);
    return c;
  }

  noteClasses(file) {
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    let v = fm.cssclasses ?? fm.cssclass ?? [];
    if (typeof v === "string") v = v.split(/[\s,]+/);
    return (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter((x) => /^[A-Za-z_-][\w-]*$/.test(x));
  }

  decorate(el, file, mapBase) {
    el.querySelectorAll("h1, h2, h3, h4, h5, h6").forEach((h) => {
      const text = h.getAttribute("data-heading") || h.textContent || "";
      if (!text.trim()) return;
      const level = parseInt(h.tagName.slice(1), 10);
      this.iconBtn(h, "pin", "Add this section to the screen", () =>
        this.plugin.addTile({ type: "section", path: file.path, heading: text.trim(), level }), "gms-pin-here");
    });
    // Maps render a moment after the note; tag them once they're in place.
    const tagMaps = () => {
      el.querySelectorAll(".block-language-zoommap").forEach((m, i) => {
        if (m.dataset.gmsTagged) return;
        m.dataset.gmsTagged = "1";
        m.addClass("gms-map-host");
        const bar = m.createDiv({ cls: "gms-map-pin" });
        const b = bar.createEl("button", { cls: "gms-map-pin-btn" });
        setIcon(b.createSpan(), "pin");
        b.createSpan({ text: "Add map to screen" });
        b.addEventListener("pointerdown", (e) => e.stopPropagation());
        b.onclick = async (e) => {
          e.stopPropagation();
          const text = await this.app.vault.cachedRead(file);
          const blocks = findMapBlocks(text);
          const block = blocks[mapBase + i];
          if (!block) return new Notice("Couldn't find this map in the note.");
          this.plugin.addTile({ type: "map", path: file.path, mapIndex: mapBase + i, mapId: block.id || undefined, mapLine: block.start, title: `${file.basename} – map` });
        };
      });
    };
    tagMaps();
    setTimeout(tagMaps, 400);
  }

  /* ---------------- Popups ---------------- */

  specKey(spec) {
    if (!spec) return "";
    return [spec.type, spec.path, spec.heading || "", spec.mapId || spec.mapLine || spec.mapIndex || "", spec.blockId || ""].join("|");
  }

  openPopup(spec) {
    // Already open? Bring that one forward instead of opening it again
    const key = this.specKey(spec);
    const open = this.popups.find((x) => this.specKey(x.history[x.history.length - 1]) === key);
    if (open) {
      if (open.el.hasClass("is-min")) this.minimizePopup(open);
      open.el.removeClass("is-top");
      this.raise(open);
      open.el.removeClass("gms-pop-flash");
      void open.el.offsetWidth;
      open.el.addClass("gms-pop-flash");
      return open;
    }
    const p = { history: [], el: null, comp: null };
    const el = this.popupLayer.createDiv({ cls: "gms-popup" });
    p.el = el;
    const n = this.popups.length;
    const W = this.stage.clientWidth || 800;
    const H = this.stage.clientHeight || 600;
    const w = Math.min(spec.type === "map" ? 760 : 560, W - 20);
    const h = Math.min(spec.type === "map" ? 560 : 520, H - 20);
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.left = `${Math.max(10, (W - w) / 2 + n * 24)}px`;
    el.style.top = `${Math.max(10, Math.min(60, (H - h) / 2) + n * 24)}px`;
    this.popups.push(p);
    this.raise(p);
    el.addEventListener("pointerdown", () => this.raise(p));
    this.showInPopup(p, spec);
    return p;
  }

  raise(p) {
    if (p.el.hasClass("is-top")) return;
    this.popups.forEach((x) => x.el.removeClass("is-top"));
    p.el.addClass("is-top");
    p.el.style.zIndex = String(++this.z);
    this.popups = this.popups.filter((x) => x !== p).concat(p);
  }

  minimizePopup(p) {
    const el = p.el;
    if (el.hasClass("is-min")) {
      el.removeClass("is-min");
      el.style.height = p.prevH || "";
    } else {
      p.prevH = el.style.height || `${el.offsetHeight}px`;
      el.addClass("is-min");
      el.style.height = "";
    }
    if (p.minBtn) setIcon(p.minBtn, el.hasClass("is-min") ? "maximize-2" : "minimize-2");
  }

  async showInPopup(p, spec, back = false) {
    if (!back) p.history.push(spec);
    if (p.comp) this.removeChild(p.comp);
    const el = p.el;
    el.empty();
    const head = el.createDiv({ cls: "gms-popup-head" });
    this.dragHandle(head, el, null);
    if (p.history.length > 1) this.iconBtn(head, "arrow-left", "Back", () => {
      p.history.pop();
      this.showInPopup(p, p.history[p.history.length - 1], true);
    });
    const ic = head.createSpan({ cls: "gms-popup-icon" });
    setIcon(ic, TILE_ICONS[spec.type] || "file-text");
    const name = spec.type === "section" ? `${(spec.path || "").split("/").pop().replace(/\.md$/, "")} › ${spec.heading}` : spec.title || (spec.path || "").split("/").pop().replace(/\.md$/, "");
    head.createDiv({ cls: "gms-popup-title", text: name });
    this.iconBtn(head, "plus", "Add to screen", () => this.plugin.addTile({ ...spec, title: spec.type === "map" ? spec.title : undefined }));
    p.minBtn = this.iconBtn(head, p.el.hasClass("is-min") ? "maximize-2" : "minimize-2", "Shrink to title / restore", () => this.minimizePopup(p));
    const f = this.app.vault.getAbstractFileByPath(spec.path);
    if (f instanceof TFile) this.iconBtn(head, "file-symlink", "Open note", () => this.openFile(f, false));
    this.iconBtn(head, "x", "Close", () => this.closePopup(p));
    const body = el.createDiv({ cls: "gms-popup-body" });
    body.toggleClass("is-map", spec.type === "map");
    p.comp = this.addChild(new Component());
    await this.renderSpec(spec, body, p.comp, (next) => this.showInPopup(p, next), true);
  }

  closePopup(p) {
    if (p.comp) this.removeChild(p.comp);
    p.el.remove();
    this.popups = this.popups.filter((x) => x !== p);
  }

  /** Drag `target` by `handle`. `onDone(x, y)` gets the snapped position; a click without movement calls `onClick`. */
  dragHandle(handle, target, onDone, onClick, snapper, locked) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button, input, textarea, a")) return;
      e.preventDefault();
      const sx = e.clientX;
      const sy = e.clientY;
      const ox = target.offsetLeft;
      const oy = target.offsetTop;
      let dx = 0;
      let dy = 0;
      let moved = false;
      let snapped = null;
      const win = target.ownerDocument.defaultView || window;
      const move = (ev) => {
        dx = ev.clientX - sx;
        dy = ev.clientY - sy;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        if (locked && locked()) {
          moved = "locked";
          return;
        }
        if (!moved) {
          moved = true;
          target.addClass("is-dragging");
        }
        dx = Math.max(-ox, dx);
        dy = Math.max(-oy, dy);
        snapped = null;
        if (snapper) {
          const sn = snapper(ox + dx, oy + dy);
          if (sn.snapped) {
            snapped = sn;
            dx = sn.x - ox;
            dy = sn.y - oy;
          }
        }
        target.toggleClass("is-snapped", !!snapped);
        target.style.transform = `translate(${dx}px, ${dy}px)`;
      };
      const up = (ev) => {
        win.removeEventListener("pointermove", move, true);
        win.removeEventListener("pointerup", up, true);
        win.removeEventListener("pointercancel", up, true);
        target.style.transform = "";
        target.removeClass("is-dragging");
        target.removeClass("is-snapped");
        if (moved === "locked") return;
        if (!moved) {
          if (onClick && ev.type === "pointerup") onClick(ev);
          return;
        }
        const x = snapped ? snapped.x : onDone ? snap(ox + dx) : Math.max(0, ox + dx);
        const y = snapped ? snapped.y : onDone ? snap(oy + dy) : Math.max(0, oy + dy);
        target.style.left = `${x}px`;
        target.style.top = `${y}px`;
        if (onDone) onDone(x, y);
      };
      win.addEventListener("pointermove", move, true);
      win.addEventListener("pointerup", up, true);
      win.addEventListener("pointercancel", up, true);
    });
  }

  resizeHandle(handle, target, onDone, minW, minH, widthOnly, snapper) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX;
      const sy = e.clientY;
      const ow = target.offsetWidth;
      const oh = target.offsetHeight;
      const win = target.ownerDocument.defaultView || window;
      target.addClass("is-resizing");
      let snapped = null;
      const move = (ev) => {
        let w = Math.max(minW, ow + ev.clientX - sx);
        let h = widthOnly ? oh : Math.max(minH, oh + ev.clientY - sy);
        snapped = null;
        if (snapper) {
          const sn = snapper(w, h);
          if (sn.snapped) {
            snapped = sn;
            w = Math.max(minW, sn.w);
            if (!widthOnly) h = Math.max(minH, sn.h);
          }
        }
        target.toggleClass("is-snapped", !!snapped);
        target.style.width = `${w}px`;
        if (!widthOnly) target.style.height = `${h}px`;
      };
      const up = () => {
        win.removeEventListener("pointermove", move, true);
        win.removeEventListener("pointerup", up, true);
        win.removeEventListener("pointercancel", up, true);
        target.removeClass("is-resizing");
        target.removeClass("is-snapped");
        const w = snapped ? Math.round(target.offsetWidth) : snap(target.offsetWidth);
        const h = snapped ? Math.round(target.offsetHeight) : snap(target.offsetHeight);
        target.style.width = `${w}px`;
        if (!widthOnly) target.style.height = `${h}px`;
        onDone(w, h);
      };
      win.addEventListener("pointermove", move, true);
      win.addEventListener("pointerup", up, true);
      win.addEventListener("pointercancel", up, true);
    });
  }

  /* ---------------- Board & tiles ---------------- */

  unloadTiles() {
    this.tileComps.forEach((c) => this.removeChild(c));
    this.tileComps = [];
    this.trays.forEach((tr) => tr.destroy());
    this.trays = [];
  }

  renderBoard() {
    this.renderLock();
    this.unloadTiles();
    this.board.empty();
    this.watch = new Set();
    const sc = this.screen;
    if (!sc.tiles.length) {
      const hint = this.board.createDiv({ cls: "gms-board-hint" });
      hint.createDiv({ text: "This screen is empty." });
      hint.createDiv({ text: "Search above and press + to add a note, or use Add for the party and the session diary. Drag tiles by their title to place them anywhere." });
    }
    for (const t of sc.tiles) this.renderTile(t);
    this.sizeBoard();
  }

  sizeBoard() {
    let w = 0;
    let h = 0;
    for (const t of this.screen.tiles) {
      const b = tileBox(t);
      w = Math.max(w, b.x + b.w);
      h = Math.max(h, b.y + b.h);
    }
    this.board.style.width = `${w + 200}px`;
    this.board.style.height = `${h + 200}px`;
  }

  isOpenTile(t) {
    return isOpenTile(t);
  }
  tileHeight(t) {
    return tileBox(t).h;
  }

  /** Shrink a tile to its name, or bring it back at the size it had. */
  toggleTile(t) {
    if (ALWAYS_OPEN.includes(t.type)) return this.plugin.updateTile(t, { collapsed: !t.collapsed }, true);
    const patch = { expanded: !t.expanded };
    if (!t.expanded && (!t.h || t.h < 120)) {
      const size = TILE_SIZES[t.type] || TILE_SIZES.note;
      patch.h = size.h;
      patch.w = size.ew || size.w;
    }
    this.plugin.updateTile(t, patch, true);
  }

  tileTitle(t) {
    if (t.title) return t.title;
    if (t.type === "party") return "Party";
    if (t.type === "combat") return "Combat";
    if (t.type === "dice") return "Dice tray";
    if (t.type === "checklist") return "Checklist";
    if (t.type === "sticky") {
      const first = String(t.text || "").split("\n").map((x) => x.trim()).find(Boolean);
      return first ? first.slice(0, 40) : "Sticky note";
    }
    if (t.type === "diary") return "Session notes";
    const base = (t.path || "").split("/").pop().replace(/\.md$/, "");
    if (t.type === "section") return `${base} › ${t.heading}`;
    if (t.type === "map") return `${base} – map`;
    return base;
  }

  renderTile(t) {
    const open = this.isOpenTile(t);
    const box = tileBox(t);
    const el = this.board.createDiv({ cls: `gms-tile gms-tile-${t.type}` });
    el.toggleClass("is-open", open);
    if (t.type === "sticky") el.addClass(`gms-sticky-${STICKY_COLORS[t.color] ? t.color : "yellow"}`);
    el.style.left = `${box.x}px`;
    el.style.top = `${box.y}px`;
    el.style.width = `${box.w}px`;
    if (open) el.style.height = `${box.h}px`;

    const head = el.createDiv({ cls: "gms-tile-head" });
    const ic = head.createSpan({ cls: "gms-tile-icon" });
    setIcon(ic, TILE_ICONS[t.type] || "file-text");
    const title = head.createSpan({ cls: "gms-tile-title", text: this.tileTitle(t) });
    if (t.path) title.addEventListener("mouseover", (e) => this.hover(e, title, t.path));
    head.createDiv({ cls: "gms-spacer" });
    if (t.type === "dice") {
      const on = !!this.plugin.settings.dice.anim3d;
      const b = this.iconBtn(head, on ? "box" : "square", on ? "3D dice: on (click to show only the number)" : "3D dice: off (click to roll 3D dice)", async () => {
        this.plugin.settings.dice.anim3d = !this.plugin.settings.dice.anim3d;
        await this.plugin.saveSettings();
        this.plugin.views().forEach((v) => v.renderBoard());
      });
      b.addClass("gms-dice-3d");
      b.toggleClass("is-on", on);
    }
    if (t.type === "party" && open) {
      this.iconBtn(head, "user-plus", "Add character", () => this.plugin.pickCharacter(t));
      this.iconBtn(head, "refresh-cw", "Refresh", () => this.renderPartyTiles());
    }
    this.iconBtn(head, open ? "minimize-2" : "maximize-2", open ? "Shrink to name" : "Show content", () => this.toggleTile(t));
    this.iconBtn(head, "more-horizontal", "Tile options", (e) => this.tileMenu(t, e));

    const clickable = !open && (t.type === "note" || t.type === "section" || t.type === "map" || t.type === "combat");
    head.toggleClass("is-clickable", clickable || (open && !!t.path));
    const locked = !!this.screen.locked;
    el.toggleClass("is-locked", locked);
    this.dragHandle(head, el, (x, y) => this.plugin.updateTile(t, { x, y }), () => {
      if (t.path) this.openPopup({ ...t });
    }, (x, y) => {
      const others = this.screen.tiles.filter((o) => o !== t).map(tileBox);
      return snapToTiles({ x, y, w: box.w, h: box.h }, others);
    }, () => !!this.screen.locked);

    // The grip goes in last, so it sits above whatever the tile's content draws.
    const addGrip = () => {
      if (locked) return;
      const grip = el.createDiv({ cls: "gms-tile-resize" });
      this.resizeHandle(grip, el, (w, h) => this.plugin.updateTile(t, open ? { w, h } : { cw: w }), 120, 80, !open, (w, h) => {
        const others = this.screen.tiles.filter((o) => o !== t).map(tileBox);
        return snapResize({ x: box.x, y: box.y, w, h }, others);
      });
    };

    if (!open) return addGrip();
    const body = el.createDiv({ cls: "gms-tile-body" });
    body.dataset.tileId = t.id;
    if (t.type === "party") this.renderParty(body, t);
    else if (t.type === "diary") this.renderDiary(body, t);
    else if (t.type === "dice") this.renderDiceTray(body, t);
    else if (t.type === "sticky") this.renderSticky(body, t, title);
    else if (t.type === "checklist") this.renderChecklist(body, t);
    else {
      body.toggleClass("is-map", t.type === "map");
      const comp = this.addChild(new Component());
      this.tileComps.push(comp);
      this.renderSpec(t, body, comp, (next) => this.openPopup(next), t.type !== "map");
    }
    addGrip();
  }

  tileMenu(t, e) {
    const m = new Menu();
    const content = t.type === "note" || t.type === "section" || t.type === "map" || t.type === "combat";
    const open = isOpenTile(t);
    m.addItem((it) => it.setTitle(open ? "Shrink to name" : "Show content on screen").setIcon(open ? "minimize-2" : "maximize-2").onClick(() => this.toggleTile(t)));
    if (content) m.addItem((it) => it.setTitle("Open in popup").setIcon("app-window").onClick(() => this.openPopup({ ...t })));
    if (t.type === "party") {
      m.addItem((it) => it.setTitle("Add character…").setIcon("user-plus").onClick(() => this.plugin.pickCharacter(t)));
      if (Array.isArray(t.members)) m.addItem((it) => it.setTitle("Use the party from settings").setIcon("rotate-ccw").onClick(() => this.plugin.updateTile(t, { members: undefined }, true)));
    }
    if (t.path) {
      const f = this.app.vault.getAbstractFileByPath(t.path);
      if (f instanceof TFile) m.addItem((it) => it.setTitle("Open note").setIcon("file-symlink").onClick(() => this.openFile(f, false)));
    }
    if (t.type === "diary") {
      m.addItem((it) => it.setTitle("Done – create session note…").setIcon("check").onClick(() => new NewSessionModal(this.plugin, this.plugin.settings.diary.draft).open()));
      m.addItem((it) => it.setTitle("Add notes to an existing note…").setIcon("file-plus").onClick(() =>
        this.plugin.pickSession((f) => this.plugin.appendNotes(f, this.plugin.settings.diary.draft))));
    }
    if (t.type === "checklist") {
      m.addItem((it) => it.setTitle("Untick everything").setIcon("rotate-ccw").onClick(() => {
        (t.items || []).forEach((x) => (x.done = false));
        this.plugin.updateTile(t, {}, true);
      }));
      m.addItem((it) => it.setTitle("Remove ticked items").setIcon("list-x").onClick(() => {
        this.plugin.updateTile(t, { items: (t.items || []).filter((x) => !x.done) }, true);
      }));
      m.addSeparator();
    }
    if (t.type === "sticky") {
      for (const [k, label] of Object.entries(STICKY_COLORS)) {
        m.addItem((it) => it.setTitle(`${(t.color || "yellow") === k ? "● " : ""}${label} paper`).setIcon("palette").onClick(() => this.plugin.updateTile(t, { color: k }, true)));
      }
      m.addSeparator();
      for (const [k, [label]] of Object.entries(STICKY_SIZES)) {
        m.addItem((it) => it.setTitle(`${(t.textSize || "m") === k ? "● " : ""}${label} text`).setIcon("type").onClick(() => this.plugin.updateTile(t, { textSize: k }, true)));
      }
      m.addSeparator();
    }
    m.addItem((it) => it.setTitle("Rename tile").setIcon("pencil").onClick(() =>
      new TextPrompt(this.app, "Rename tile", this.tileTitle(t), (name) => this.plugin.updateTile(t, { title: name }, true)).open()));
    const others = this.plugin.settings.screens.filter((s) => s.id !== this.screen.id);
    if (others.length) {
      m.addSeparator();
      for (const s of others) {
        m.addItem((it) => it.setTitle(`Move to "${s.name}"`).setIcon("arrow-right-left").onClick(() => this.plugin.moveTile(t, s.id)));
      }
    }
    m.addSeparator();
    m.addItem((it) => it.setTitle("Remove from screen").setIcon("trash").onClick(() => this.plugin.removeTile(t)));
    m.showAtMouseEvent(e);
  }

  /* ---------------- Party ---------------- */

  renderPartyTiles() {
    this.board.querySelectorAll(".gms-tile-party .gms-tile-body").forEach((b) => {
      const t = this.screen.tiles.find((x) => x.id === b.dataset.tileId);
      this.renderParty(b, t);
    });
  }

  renderParty(body, t) {
    body.empty();
    const reader = this.plugin.party;
    const members = reader.members(t);
    if (!members.length) {
      const empty = body.createDiv({ cls: "gms-empty" });
      empty.createDiv({ text: "No characters in this party yet." });
      const b = empty.createEl("button", { cls: "gms-party-add", text: "Add character" });
      b.onclick = () => this.plugin.pickCharacter(t);
      return;
    }
    const grid = body.createDiv({ cls: "gms-party" });
    grid.toggleClass("is-compact", !!this.plugin.settings.compactParty);
    for (const file of members) {
      let data;
      try {
        data = reader.read(file);
      } catch (e) {
        console.error("Game Master Interactive Screen: could not read", file.path, e);
        continue;
      }
      data.watch.forEach((p) => this.watch.add(p));
      this.renderCard(grid, data, t, members.length);
    }
  }

  renderCard(grid, d, t, count) {
    const card = grid.createDiv({ cls: "gms-card" });
    const bar = d.fields.find((f) => f.display === "bar" && f.value && f.value.max);
    const down = d.dead || d.dying || (bar && bar.value.cur <= 0);
    card.toggleClass("is-down", !!down);

    const top = card.createDiv({ cls: "gms-card-top" });
    if (d.image) {
      const img = top.createEl("img", { cls: "gms-avatar", attr: { src: d.image, alt: "" } });
      img.onerror = () => img.remove();
    }
    const id = top.createDiv({ cls: "gms-card-id" });
    const name = id.createEl("a", { cls: "gms-card-name", text: d.name });
    name.onclick = (e) => {
      if (e.ctrlKey || e.metaKey) this.openFile(d.file, true);
      else this.openPopup({ type: "note", path: d.file.path });
    };
    name.addEventListener("mouseover", (e) => this.hover(e, name, d.file.path));
    if (d.subtitle) id.createDiv({ cls: "gms-card-sub", text: d.subtitle });
    const condField = d.fields.find((f) => f.display === "tags" && /conditions/.test(f.source || ""));
    const concentrating = this.plugin.settings.concentration !== false && condField && (Array.isArray(condField.value) ? condField.value : String(condField.value || "").split(/,\s*/)).some(isConcentration);
    if (concentrating) {
      card.addClass("is-concentrating");
      const cb = id.createDiv({ cls: "gms-conc-badge", attr: { "aria-label": "Concentrating on a spell" } });
      setIcon(cb.createSpan(), "target");
      cb.createSpan({ text: "Concentrating" });
    }
    this.plugin.watchConcentration(d, concentrating);
    const fight = this.plugin.combatantFor(d.file, d.name);
    if (fight) {
      const tag = id.createDiv({ cls: "gms-fight" });
      if (fight.init !== null && fight.init !== undefined) tag.createSpan({ cls: "gms-fight-init", text: `Init ${fight.init}` });
      if (fight.current) {
        card.addClass("is-turn");
        tag.createSpan({ cls: "gms-fight-turn", text: "Their turn" });
      } else if (fight.isNext) {
        card.addClass("is-next");
        tag.createSpan({ cls: "gms-fight-next", text: "On deck" });
      }
    }
    if (d.dead) id.createDiv({ cls: "gms-badge is-bad", text: "Dead" });
    else if (down) id.createDiv({ cls: "gms-badge is-bad", text: "Down" });

    for (const f of d.fields) {
      if (f.display !== "shield") continue;
      const v = f.value;
      if (v === undefined || v === null || v === "") continue;
      const sh = top.createDiv({ cls: "gms-shield", attr: { "aria-label": `${f.label}: ${v}` } });
      sh.innerHTML = '<svg viewBox="0 0 32 36" aria-hidden="true"><path d="M16 1.5 30 6v10.5c0 8.6-5.9 14.7-14 18-8.1-3.3-14-9.4-14-18V6z"/></svg>';
      sh.createDiv({ cls: "gms-shield-val", text: String(v) });
      sh.createDiv({ cls: "gms-shield-label", text: f.label });
    }
    if (t) {
      const ctl = card.createDiv({ cls: "gms-card-ctl" });
      if (count > 1) this.iconBtn(ctl, "arrow-left", "Move earlier", () => this.plugin.partyMove(t, d.file.path, -1));
      this.iconBtn(ctl, "x", "Remove from this party", () => this.plugin.partyRemove(t, d.file.path));
    }

    for (const f of d.fields) if (f.display === "bar") this.renderBar(card, f);

    // Number fields, in order; fields sharing a group sit together under its name
    let section = null;
    let sectionGroup;
    for (const f of d.fields) {
      if (f.display !== "text" && f.display) continue;
      const v = f.value;
      if (v === undefined || v === null || v === "") continue;
      const g = f.group || "";
      if (!section || g !== sectionGroup) {
        sectionGroup = g;
        section = card.createDiv({ cls: g ? "gms-stat-group" : "gms-stats" });
        if (g) {
          section.createDiv({ cls: "gms-stat-group-title", text: g });
          section = section.createDiv({ cls: "gms-stats" });
        }
      }
      const box = section.createDiv({ cls: "gms-stat" });
      box.createDiv({ cls: "gms-stat-val", text: Array.isArray(v) ? v.join(", ") : String(v) });
      box.createDiv({ cls: "gms-stat-label", text: f.label });
    }
    for (const f of d.fields) {
      if (f.display === "tags") this.renderTags(card, f);
      else if (f.display === "pips") this.renderPips(card, f);
    }
  }

  renderBar(card, f) {
    const { cur, max, temp } = f.value || {};
    if (cur === undefined && max === undefined) return;
    const wrap = card.createDiv({ cls: "gms-bar-wrap" });
    const label = wrap.createDiv({ cls: "gms-bar-label" });
    label.createSpan({ text: f.label });
    label.createSpan({ cls: "gms-bar-num", text: max ? `${cur ?? "?"} / ${max}` : String(cur) });
    if (temp) label.createSpan({ cls: "gms-bar-temp", text: `+${temp}` });
    if (max) {
      const ratio = Math.max(0, Math.min(1, (cur || 0) / max));
      const fill = wrap.createDiv({ cls: "gms-bar" }).createDiv({ cls: "gms-bar-fill" });
      fill.style.width = `${Math.round(ratio * 100)}%`;
      fill.addClass(ratio > 0.5 ? "is-ok" : ratio > 0.25 ? "is-hurt" : "is-bad");
    }
  }

  renderTags(card, f) {
    let list = Array.isArray(f.value) ? f.value : f.value ? String(f.value).split(/,\s*/) : [];
    if (this.plugin.settings.concentration !== false) list = list.filter((x) => !isConcentration(x)); // shown as its own badge
    if (!list.length) return;
    const row = card.createDiv({ cls: "gms-tags" });
    for (const t of list) {
      const name = stripLink(t);
      const chip = row.createEl("a", { cls: "gms-tag", text: name });
      chip.onclick = () => {
        const target = this.app.metadataCache.getFirstLinkpathDest(name.replace(/\s+\d+$/, ""), "");
        if (target instanceof TFile) this.openPopup({ type: "note", path: target.path });
      };
    }
  }

  renderPips(card, f) {
    const slots = Array.isArray(f.value) ? f.value : [];
    if (!slots.length) return;
    const row = card.createDiv({ cls: "gms-slots" });
    for (const s of slots) {
      const g = row.createDiv({ cls: "gms-slot", attr: { "aria-label": `${ordinal(s.level)} level: ${s.total - s.used} of ${s.total} left` } });
      g.createSpan({ cls: "gms-slot-lvl", text: String(s.level) });
      for (let i = 0; i < s.total; i++) g.createSpan({ cls: i < s.total - s.used ? "gms-pip is-full" : "gms-pip" });
    }
  }

  /* ---------------- Checklist ---------------- */

  renderChecklist(body, t) {
    body.addClass("gms-checklist");
    if (!Array.isArray(t.items)) t.items = [];
    const paper = body.createDiv({ cls: "gms-cl-paper" });
    const progress = paper.createDiv({ cls: "gms-cl-progress" });
    const list = paper.createDiv({ cls: "gms-cl-list" });
    const save = () => this.plugin.saveSoon();
    const draw = () => {
      list.empty();
      const done = t.items.filter((x) => x.done).length;
      progress.setText(t.items.length ? `${done} / ${t.items.length} done` : "");
      progress.toggleClass("is-complete", !!t.items.length && done === t.items.length);
      t.items.forEach((item, i) => {
        const row = list.createDiv({ cls: "gms-cl-item" });
        row.toggleClass("is-done", !!item.done);
        const box = row.createEl("button", { cls: "gms-cl-box", attr: { role: "checkbox", "aria-checked": item.done ? "true" : "false", "aria-label": item.done ? "Mark as not done" : "Mark as done" } });
        if (item.done) setIcon(box, "check");
        box.onclick = () => { item.done = !item.done; save(); draw(); };
        const txt = row.createEl("input", { type: "text", cls: "gms-cl-text", value: item.text || "" });
        txt.addEventListener("input", () => { item.text = txt.value; save(); });
        txt.addEventListener("keydown", (e) => {
          e.stopPropagation();
          if (e.key === "Enter") {
            e.preventDefault();
            t.items.splice(i + 1, 0, { id: uid(), text: "", done: false });
            save();
            draw();
            const next = list.querySelectorAll(".gms-cl-text")[i + 1];
            if (next) next.focus();
          } else if (e.key === "Backspace" && !txt.value) {
            e.preventDefault();
            t.items.splice(i, 1);
            save();
            draw();
            const prev = list.querySelectorAll(".gms-cl-text")[Math.max(0, i - 1)];
            if (prev) prev.focus();
          }
        });
        txt.addEventListener("pointerdown", (e) => e.stopPropagation());
        const x = row.createEl("button", { cls: "gms-cl-del", attr: { "aria-label": "Remove" } });
        setIcon(x, "x");
        x.onclick = () => { t.items.splice(i, 1); save(); draw(); };
      });
    };
    const add = paper.createEl("input", { type: "text", cls: "gms-cl-add", attr: { placeholder: "+ Add an item (Enter)" } });
    add.addEventListener("pointerdown", (e) => e.stopPropagation());
    add.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key !== "Enter" || !add.value.trim()) return;
      e.preventDefault();
      t.items.push({ id: uid(), text: add.value.trim(), done: false });
      add.value = "";
      save();
      draw();
      list.scrollTop = list.scrollHeight;
    });
    draw();
  }

  /* ---------------- Sticky note ---------------- */

  renderSticky(body, t, titleEl) {
    body.addClass("gms-sticky");
    const scale = (STICKY_SIZES[t.textSize] || STICKY_SIZES.m)[1];
    body.style.setProperty("--gms-sticky-scale", String(scale));
    const ta = body.createEl("textarea", {
      cls: "gms-sticky-text",
      attr: { spellcheck: "true", placeholder: "Write it down so you don't forget…\n\ne.g. Grapple = Athletics vs. DC 8 + STR + PB" },
    });
    ta.value = t.text || "";
    ta.setAttribute("wrap", "soft");
    // Rule the paper from the real line height, so text sits on the lines with any font and size
    const rule = () => {
      const fs = parseFloat(getComputedStyle(ta).fontSize) || 16;
      ta.style.setProperty("--gms-sticky-pitch", `${Math.round(fs * 1.5)}px`);
    };
    rule();
    const ro = new ResizeObserver(rule);
    ro.observe(body);
    const comp = this.addChild(new Component());
    this.tileComps.push(comp);
    comp.register(() => ro.disconnect());
    ta.addEventListener("input", () => {
      t.text = ta.value;
      if (!t.title) titleEl.setText(this.tileTitle(t));
      this.plugin.saveSoon();
    });
    // keep typing from starting a drag or closing popups
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
    ta.addEventListener("keydown", (e) => e.stopPropagation());
  }

  /* ---------------- Dice tray ---------------- */

  renderDiceTray(body, t) {
    body.addClass("gms-dice");
    const plugin = this.plugin;
    const pool = {};
    let adv = null;

    const pick = body.createDiv({ cls: "gms-dice-pick" });
    for (const n of [4, 6, 8, 10, 12, 20, 100]) {
      const b = pick.createEl("button", { cls: "gms-die-btn", text: `d${n}`, attr: { "aria-label": `Add a d${n} · right-click removes one` } });
      b.onclick = () => { pool[n] = (pool[n] || 0) + 1; sync(); };
      b.oncontextmenu = (e) => { e.preventDefault(); if (pool[n]) { pool[n]--; sync(); } };
    }
    const row = body.createDiv({ cls: "gms-dice-row" });
    const input = row.createEl("input", { type: "text", cls: "gms-dice-formula", attr: { placeholder: "1d20+5", spellcheck: "false" } });
    const advB = row.createEl("button", { cls: "gms-dice-adv", text: "Adv", attr: { "aria-label": "Advantage (roll 2d20, keep the higher)" } });
    const disB = row.createEl("button", { cls: "gms-dice-adv", text: "Dis", attr: { "aria-label": "Disadvantage (roll 2d20, keep the lower)" } });
    const kindSel = row.createEl("select", { cls: "dropdown gms-dice-kind", attr: { "aria-label": "What this roll is for (Damage / Heal ask Roll for Initiative who takes it)" } });
    for (const [v, l] of [["", "Roll"], ["Damage", "Damage"], ["Healing", "Heal"]]) kindSel.createEl("option", { value: v, text: l });
    kindSel.value = plugin.settings.dice.trayKind || "";
    kindSel.onchange = () => { plugin.settings.dice.trayKind = kindSel.value; plugin.saveSoon(); };
    const rollB = row.createEl("button", { cls: "mod-cta gms-dice-roll", text: "Roll" });
    this.iconBtn(row, "eraser", "Clear", () => {
      for (const k of Object.keys(pool)) delete pool[k];
      input.value = "";
      adv = null;
      sync();
    });
    const sync = () => {
      const dice = Object.keys(pool).map(Number).filter((k) => pool[k] > 0).sort((a, b) => a - b).map((k) => `${pool[k]}d${k}`);
      if (dice.length) {
        const mod = /([+-]\s*\d+)\s*$/.exec(input.value);
        input.value = dice.join(" + ") + (mod && !/d/i.test(mod[1]) ? ` ${mod[1].replace(/\s+/g, " ")}` : "");
      }
      advB.toggleClass("is-on", adv === "adv");
      disB.toggleClass("is-on", adv === "dis");
    };
    input.addEventListener("input", () => { for (const k of Object.keys(pool)) delete pool[k]; });
    const go = () => {
      const f = input.value.trim() || "1d20";
      if (!parseFormula(f)) return new Notice(`"${f}" isn't a dice formula. Try 1d20+5 or 2d6+1d4.`);
      plugin.rollInTray(withAdvantage(f, adv), undefined, kindSel.value || null);
    };
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go(); } });
    advB.onclick = () => { adv = adv === "adv" ? null : "adv"; sync(); };
    disB.onclick = () => { adv = adv === "dis" ? null : "dis"; sync(); };
    rollB.onclick = go;

    const area = body.createDiv({ cls: "gms-dice-area" });
    const canvas = area.createEl("canvas", { cls: "gms-dice-canvas" });
    const result = area.createDiv({ cls: "gms-dice-result" });
    const hist = body.createDiv({ cls: "gms-dice-history" });
    const stage = new DiceStage(canvas);
    const ro = new ResizeObserver(() => stage.resize(area.clientWidth, area.clientHeight));
    ro.observe(area);

    const showResult = (r) => {
      result.empty();
      result.removeClass("is-list");
      const crit = critOf(r);
      result.toggleClass("is-crit", crit === "crit");
      result.toggleClass("is-fumble", crit === "fumble");
      result.toggleClass("is-big", !plugin.settings.dice.anim3d);
      result.createDiv({ cls: "gms-dice-result-label", text: r.who || r.label });
      result.createDiv({ cls: "gms-dice-result-total", text: String(r.total) });
      result.createDiv({ cls: "gms-dice-result-detail", text: breakdown(r) });
      const what = rollWhat(r);
      if (what) result.createDiv({ cls: "gms-dice-result-what", text: what });
      result.addClass("is-shown");
    };
    const renderHistory = () => {
      hist.empty();
      for (const h of (plugin.settings.dice.history || []).slice(0, 8)) {
        const chip = hist.createEl("button", { cls: "gms-dice-hist", text: `${h.label}: ${h.total}`, attr: { "aria-label": `Roll ${h.formula} again` } });
        chip.onclick = () => plugin.rollInTray(h.formula, h.label);
      }
    };
    renderHistory();

    const tray = {
      el: body,
      area,
      stage,
      prepare() {
        result.removeClass("is-shown");
        stage.clear();
      },
      async present(r, animate) {
        result.removeClass("is-shown");
        if (animate) await stage.play(visualDice(r));
        else stage.clear();
        showResult(r);
      },
      /** Several results at once (initiative for the whole fight). */
      async presentList(title, rows, dice) {
        result.removeClass("is-shown");
        if (dice) await stage.play(dice);
        result.empty();
        result.removeClass("is-crit");
        result.removeClass("is-fumble");
        result.removeClass("is-big");
        result.addClass("is-list");
        result.createDiv({ cls: "gms-dice-result-label", text: title });
        const list = result.createDiv({ cls: "gms-dice-result-list" });
        for (const r of rows.slice(0, 12)) list.createDiv({ text: `${r.label}: ${r.total}` });
        if (rows.length > 12) list.createDiv({ text: `+ ${rows.length - 12} more` });
        result.addClass("is-shown");
      },
      history: renderHistory,
      destroy() {
        stage.stop();
        ro.disconnect();
      },
    };
    this.trays.push(tray);
  }

  /* ---------------- Session diary ---------------- */

  renderDiary(body, t) {
    body.addClass("gms-diary");
    const d = this.plugin.settings.diary;
    const ta = body.createEl("textarea", {
      cls: "gms-diary-text",
      attr: { spellcheck: "true", placeholder: "What happens this session… It's kept as you type. Press Done to turn it into the session note." },
    });
    ta.value = d.draft || "";
    ta.addEventListener("input", () => {
      d.draft = ta.value;
      this.plugin.saveSoon();
    });
    const quick = body.createEl("input", { type: "text", cls: "gms-diary-quick", attr: { placeholder: "Quick note — Enter adds it with the time" } });
    quick.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || !quick.value.trim()) return;
      e.preventDefault();
      const line = `- **${moment().format("HH:mm")}** ${quick.value.trim()}`;
      quick.value = "";
      const v = ta.value.replace(/\s+$/, "");
      ta.value = (v ? v + "\n" : "") + line + "\n";
      ta.scrollTop = ta.scrollHeight;
      d.draft = ta.value;
      this.plugin.saveSoon();
    });

    const bar = body.createDiv({ cls: "gms-diary-bar" });
    const done = bar.createEl("button", { cls: "mod-cta gms-diary-done" });
    setIcon(done.createSpan(), "check");
    done.createSpan({ text: "Done – create session note" });
    done.onclick = () => {
      d.draft = ta.value;
      new NewSessionModal(this.plugin, ta.value).open();
    };
    const add = this.iconBtn(bar, "file-plus", "Add these notes to an existing note", () => {
      d.draft = ta.value;
      if (!ta.value.trim()) return new Notice("Write something first.");
      this.plugin.pickSession((f) => this.plugin.appendNotes(f, ta.value));
    });
    add.addClass("gms-diary-append");
    bar.createDiv({ cls: "gms-spacer" });
    const last = this.plugin.diaryFile();
    if (last) {
      const a = bar.createEl("a", { cls: "gms-diary-last", text: last.basename, attr: { "aria-label": "Last session note" } });
      a.onclick = () => this.openPopup({ type: "note", path: last.path });
      a.addEventListener("mouseover", (e) => this.hover(e, a, last.path));
    }
    this.iconBtn(bar, "eraser", "Clear the draft", () => {
      if (!ta.value.trim()) return;
      new ConfirmPrompt(this.app, "Clear draft", "Throw away the text you've written here?", async () => {
        d.draft = "";
        ta.value = "";
        await this.plugin.saveSettings();
      }, "Clear").open();
    });
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class SessionPicker extends FuzzySuggestModal {
  constructor(plugin, files, onPick) {
    super(plugin.app);
    this.plugin = plugin;
    this.files = files;
    this.onPick = onPick;
    this.setPlaceholder("Add the notes to which note?");
  }
  getItems() { return this.files; }
  getItemText(f) { return f.basename; }
  onChooseItem(f) { this.onPick(f); }
}

class CharacterPicker extends FuzzySuggestModal {
  /** `exclude`: paths already chosen; `onPick(file)` gets the choice. */
  constructor(plugin, exclude, onPick, placeholder) {
    super(plugin.app);
    this.plugin = plugin;
    this.onPick = onPick;
    this.setPlaceholder(placeholder || "Add a character");
    const inParty = new Set(exclude || []);
    const looksLikeCharacter = (f) => {
      const c = plugin.app.metadataCache.getFileCache(f) || {};
      const fm = c.frontmatter || {};
      return fm.data_id !== undefined || fm.hp_max !== undefined || fm.character_name !== undefined || fm.hp_current !== undefined;
    };
    const files = plugin.app.vault.getMarkdownFiles().filter((f) => !inParty.has(f.path));
    const chars = files.filter(looksLikeCharacter).sort((a, b) => a.basename.localeCompare(b.basename));
    const rest = files.filter((f) => !looksLikeCharacter(f));
    this.items = chars.concat(rest);
  }
  getItems() { return this.items; }
  getItemText(f) { return `${f.basename}  ·  ${f.parent ? f.parent.path : ""}`; }
  onChooseItem(f) { this.onPick(f); }
}

class GmScreenPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.party = new PartyReader(this);
    this.index = new SearchIndex(this);
    this.saveSoon = debounce(() => this.saveSettings(), 400, true);

    this.registerView(VIEW_TYPE, (leaf) => new GmScreenView(leaf, this));
    this.registerHoverLinkSource(VIEW_TYPE, { display: "Game Master Interactive Screen", defaultMod: true });
    this.addRibbonIcon("shield", "Open Game Master Interactive Screen", () => this.activate());

    this.addCommand({ id: "open", name: "Open Game Master Interactive Screen", callback: () => this.activate() });
    this.addCommand({
      id: "focus-search",
      name: "Search from Game Master Interactive Screen",
      callback: async () => {
        const v = await this.activate();
        if (v) v.focusSearch();
      },
    });
    this.addCommand({
      id: "add-active-note",
      name: "Add current note to the screen",
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== "md") return false;
        if (!checking) this.addTile({ type: "note", path: f.path });
        return true;
      },
    });
    this.addCommand({
      id: "add-section-at-cursor",
      name: "Add section at cursor to the screen",
      editorCheckCallback: (checking, editor, ctx) => {
        const sec = ctx.file && this.headingAt(editor.getValue(), editor.getCursor().line);
        if (!sec) return false;
        if (!checking) this.addTile({ type: "section", path: ctx.file.path, heading: sec.heading, level: sec.level });
        return true;
      },
    });
    this.addCommand({
      id: "add-map-at-cursor",
      name: "Add map at cursor to the screen",
      editorCheckCallback: (checking, editor, ctx) => {
        const hit = ctx.file && this.mapAt(editor.getValue(), editor.getCursor().line);
        if (!hit) return false;
        if (!checking) this.addMapTile(ctx.file, hit);
        return true;
      },
    });
    this.cards = new RollCards();
    // The character sheet opens its "Jump to…" menu on <body>; when it came from a note on the screen, keep it in that popup/tile
    this.registerDomEvent(document, "pointerdown", (e) => {
      const host = e.target && e.target.closest && e.target.closest(".gms-note-host");
      this.lastHostTouch = host ? { host, t: Date.now() } : null;
    }, true);
    this.menuObserver = new MutationObserver((muts) => {
      for (const m of muts) for (const n of Array.from(m.addedNodes)) {
        if (n.nodeType === 1 && n.classList.contains("mobile-nav-menu-overlay")) this.adoptMenu(n);
      }
    });
    this.menuObserver.observe(document.body, { childList: true });
    this.responsive = new ResponsiveNotes(this);
    this.registerEvent(this.app.workspace.on("css-change", () => this.responsive.rebuildSoon()));
    this.api = {
      /** Roll a formula on the GM screen: tray animation (if open) + result card. */
      roll: (formula, label) => this.roll(formula, label, "api"),
    };
    this.registerEvent(this.app.workspace.on("game-master-screen:roll", (formula, label) => this.roll(formula, label, "event")));
    // Rolls from the Dice Roller plugin (character sheet buttons, Fantasy Statblocks): only ones the user clicked
    this.registerDomEvent(document, "click", (e) => {
      const el = e.target && e.target.closest && e.target.closest(".dice-roller");
      if (!el) return;
      this.lastDiceClick = { t: Date.now(), label: guessRollLabel(el), ctx: rollContext(el, (x) => this.noteOfElement(x)) };
      this.placeDiceRenderer();
    }, true);
    this.registerEvent(this.app.workspace.on("dice-roller:new-result", (roller) => {
      if (!this.settings.dice.catchDiceRoller) return;
      const c = this.lastDiceClick;
      if (!c || Date.now() - c.t > 12000) return;
      this.lastDiceClick = null;
      const r = resultFromDiceRoller(roller, (c.ctx && c.ctx.action) || c.label);
      if (r && c.ctx) Object.assign(r, { who: c.ctx.who, whoPath: c.ctx.whoPath, action: c.ctx.action, kind: c.ctx.kind, damageType: c.ctx.damageType });
      const dr = this.app.plugins.plugins["obsidian-dice-roller"];
      // Dice Roller already threw its 3D dice (in the tray, or across the window): don't throw them again
      if (r) this.presentRoll(r, { rendered: !!(dr && dr.data && dr.data.renderer) });
    }));
    this.addCommand({
      id: "roll-dice",
      name: "Roll dice…",
      callback: () => new TextPrompt(this.app, "Roll dice", "1d20", (f) => this.roll(f, undefined, "command"), "Roll").open(),
    });
    this.addCommand({ id: "new-combat", name: "New combat on the screen", callback: () => new CombatBuilder(this).open() });
    this.addCommand({ id: "refresh-party", name: "Refresh party", callback: () => this.views().forEach((v) => v.renderPartyTiles()) });

    this.registerEvent(this.app.workspace.on("file-menu", (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((it) => it.setTitle("Add to Game Master screen").setIcon("shield").onClick(() => this.addTile({ type: "note", path: file.path })));
    }));
    this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor, ctx) => {
      if (!ctx.file) return;
      const line = editor.getCursor().line;
      const text = editor.getValue();
      const map = this.mapAt(text, line);
      if (map) {
        menu.addItem((it) => it.setTitle("Add map to Game Master screen").setIcon("map").onClick(() => this.addMapTile(ctx.file, map)));
        return;
      }
      const sec = this.headingAt(text, line);
      if (sec) menu.addItem((it) => it.setTitle(`Add "${sec.heading}" to Game Master screen`).setIcon("heading").onClick(() =>
        this.addTile({ type: "section", path: ctx.file.path, heading: sec.heading, level: sec.level })));
    }));

    this.registerEvent(this.app.metadataCache.on("changed", (file) => this.index.invalidate(file.path)));
    this.registerEvent(this.app.vault.on("delete", (file) => this.index.invalidate(file.path)));
    this.registerEvent(this.app.vault.on("rename", async (file, oldPath) => {
      this.index.invalidate(oldPath);
      let changed = false;
      for (const sc of this.settings.screens) for (const t of sc.tiles) if (t.path === oldPath) { t.path = file.path; changed = true; }
      if (this.settings.diary.current === oldPath) { this.settings.diary.current = file.path; changed = true; }
      if (changed) {
        await this.saveSettings();
        this.refreshViews();
      }
    }));

    this.addSettingTab(new GmScreenSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStart && !this.app.workspace.getLeavesOfType(VIEW_TYPE).length) this.activate(false);
      this.connectInitiative();
    });
    // Roll for Initiative may load after us, or be turned on later
    this.registerEvent(this.app.workspace.on("roll-initiative:change", (st) => this.onCombatChange(st)));
    this.registerInterval(window.setInterval(() => this.connectInitiative(), 10000));
  }

  onunload() {
    const ri = this.ri();
    if (ri && this.rollerHook && typeof ri.setRoller === "function") ri.setRoller(null);
    if (this.cards) this.cards.destroy();
    if (this.responsive) this.responsive.destroy();
    if (this.menuObserver) this.menuObserver.disconnect();
    document.body.removeClass("gms-dice-in-tray");
  }

  /* ---- Roll for Initiative ---- */

  /** Roll for Initiative's API, if it's 1.5+ (has getState). */
  ri() {
    const p = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["roll-initiative"];
    const api = p && p.api;
    return api && typeof api.getState === "function" ? api : null;
  }
  /** Hook our dice into its rolls and pick up the current fight. */
  async connectInitiative() {
    const ri = this.ri();
    if (!ri) return;
    if (typeof ri.setRoller === "function" && this.settings.dice.initiativeInTray !== false && this.hookedTo !== ri) {
      this.rollerHook = { rollMany: (reqs) => this.rollManyForInitiative(reqs) };
      ri.setRoller(this.rollerHook);
      this.hookedTo = ri;
    }
    if (!this.combatState) {
      try {
        const st = await ri.getState();
        if (st) this.onCombatChange(st);
      } catch (e) { /* no fight */ }
    }
  }
  unhookInitiative() {
    const ri = this.ri();
    if (ri && typeof ri.setRoller === "function") ri.setRoller(null);
    this.hookedTo = null;
    this.rollerHook = null;
  }
  onCombatChange(st) {
    // Concentrating creatures that just lost HP (incl. temp HP) → concentration check
    if (st && st.running && !st.ended && this.settings.concentration !== false && Array.isArray(st.combatants)) {
      const prev = this.combatHp || {};
      const now = {};
      for (const c of st.combatants) {
        const key = `${st.sourcePath}|${c.name}`;
        const hp = (Number(c.hp) || 0) + (Number(c.temp) || 0);
        now[key] = hp;
        if (prev[key] !== undefined && hp < prev[key] && (c.conditions || []).some(isConcentration)) {
          const file = c.link ? this.app.metadataCache.getFirstLinkpathDest(String(c.link).replace(/\.md$/, ""), "") : null;
          this.concentrationCheck({ name: c.name, file, damage: prev[key] - hp });
        }
      }
      this.combatHp = now;
    } else if (!st || st.ended) this.combatHp = {};
    this.combatState = st || null;
    this.views().forEach((v) => {
      v.renderCombatBar();
      v.renderPartySoon();
    });
  }
  /** Party cards outside a fight: HP drop on a concentrating character → concentration check. */
  watchConcentration(d, concentrating) {
    const bar = d.fields.find((f) => f.display === "bar" && f.value);
    if (!bar) return;
    const hp = (Number(bar.value.cur) || 0) + (Number(bar.value.temp) || 0);
    this.partyHp = this.partyHp || {};
    const prev = this.partyHp[d.file.path];
    this.partyHp[d.file.path] = hp;
    if (concentrating && prev !== undefined && hp < prev) this.concentrationCheck({ name: d.name, file: d.file, damage: prev - hp });
  }
  /** CON save bonus: the sheet's saves list, a statblock's saves, or its CON score. */
  conSave(file) {
    if (!(file instanceof TFile)) return 0;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    if (this.party.sheet || fm.data_id) {
      const ab = this.party.companion(file, fm, "Abilities");
      const sv = Array.isArray(ab.saves_list) ? ab.saves_list.find((x) => /^con/i.test(String(x.ability || ""))) : null;
      if (sv && toInt(sv.mod) !== undefined) return toInt(sv.mod);
      if (toInt(ab.con_mod) !== undefined && fm.data_id) return toInt(ab.con_mod);
    }
    const saves = fm.saves;
    if (Array.isArray(saves)) {
      for (const o of saves) if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (/^con/i.test(k) && toInt(v) !== undefined) return toInt(v);
    } else if (saves && typeof saves === "object") {
      for (const [k, v] of Object.entries(saves)) if (/^con/i.test(k) && toInt(v) !== undefined) return toInt(v);
    }
    if (Array.isArray(fm.stats) && toInt(fm.stats[2]) !== undefined) return Math.floor((toInt(fm.stats[2]) - 10) / 2);
    return 0;
  }
  concentrationCheck({ name, file, damage }) {
    if (this.settings.concentration === false || !(damage > 0)) return;
    const key = `${name}|${damage}`;
    const now = Date.now();
    this.concSeen = (this.concSeen || []).filter((x) => now - x.t < 3000);
    if (this.concSeen.some((x) => x.key === key)) return; // same hit seen from the fight and from the sheet
    this.concSeen.push({ key, t: now });
    const dc = concentrationDC(damage);
    const mod = this.conSave(file);
    this.cards.showConcentration({
      name, damage, dc, mod,
      roll: () => this.rollInTray(`1d20${mod >= 0 ? "+" : ""}${mod}`, "Concentration save", null, (r) => {
        const kept = r.total >= dc;
        r.who = name;
        r.what = `Concentration save vs DC ${dc}: ${kept ? "keeps concentration" : "loses concentration"}`;
        r.outcome = kept ? "pass" : "fail";
      }),
    });
  }
  /** The party card's place in the running fight, if any. */
  combatantFor(file, name) {
    const st = this.combatState;
    if (!st || !st.running || st.ended || !Array.isArray(st.combatants)) return null;
    const norm = (x) => String(x || "").replace(/\.md$/, "").split("/").pop().toLowerCase();
    const c = st.combatants.find((x) => (x.link && (x.link === file.path || norm(x.link) === norm(file.path))) || x.name === name || x.name === file.basename);
    if (!c) return null;
    return { ...c, isNext: !!st.next && c.name === st.next };
  }
  /** Add → Combat: Roll for Initiative's own wizard; pin what it makes. Our builder only without it. */
  async newCombat() {
    const ri = this.ri();
    if (!ri || typeof ri.newCombat !== "function") return new CombatBuilder(this).open();
    const tile = this.activeScreen().tiles.find((t) => t.type === "party");
    const players = this.party.members(tile).map((f) => f.path);
    const res = await ri.newCombat({ players });
    if (!res) return;
    if (res.kind === "encounter" && res.path) {
      await this.addTile({ type: "combat", path: res.path, blockId: res.id || undefined, title: res.name || "Combat" });
    } else if (res.kind === "initiative" && res.text) {
      try {
        await navigator.clipboard.writeText(res.text);
        new Notice("Initiative copied. Paste it into any note (an adventure, a location, the session plan).");
      } catch (e) {
        new Notice("Initiative created – copy it from Roll for Initiative's window.");
      }
    }
  }
  /** "+ to the fight" from search. */
  async addToFight(file) {
    const ri = this.ri();
    if (!ri) return;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const isPc = fm.data_id !== undefined || fm.character_name !== undefined || fm.hp_max !== undefined;
    const link = this.app.metadataCache.fileToLinktext(file, "", true);
    const ok = await ri.addCombatant(`[[${link}]] ${isPc ? "player" : "enemy"}`);
    new Notice(ok ? `${file.basename} joined the fight` : "No fight to join – start one with Add → Combat.");
  }
  /**
   * Roll for Initiative's dice (api.setRoller). Every "1dN±m" request is
   * thrown together as one handful of dice in the tray (Dice Roller 3D when
   * available); anything else is rolled quietly. One result card lists all.
   */
  async rollManyForInitiative(reqs) {
    const out = new Array(reqs.length);
    const simple = [];
    reqs.forEach((q, i) => {
      const m = /^1d(\d+)([+-]\d+)?$/i.exec(String(q.formula || "").replace(/\s+/g, ""));
      if (m) simple.push({ i, sides: parseInt(m[1], 10), mod: m[2] ? parseInt(m[2], 10) : 0 });
    });
    const detail = new Array(reqs.length);
    const sides = [...new Set(simple.map((x) => x.sides))];
    if (simple.length && sides.length === 1) {
      const vals = await this.throwHandful(simple.length, sides[0]);
      simple.forEach((x, k) => {
        out[x.i] = vals[k] + x.mod;
        detail[x.i] = { die: vals[k], mod: x.mod, sides: x.sides };
      });
    }
    reqs.forEach((q, i) => {
      if (out[i] !== undefined) return;
      const r = rollFormula(q.formula);
      out[i] = r ? r.total : 0;
      detail[i] = r ? { text: breakdown(r) } : null;
    });
    const kind = reqs[0] && reqs[0].kind;
    const title = kind === "hp" ? "Hit points" : "Initiative";
    const rows = reqs.map((q, i) => {
      const d = detail[i] || {};
      const txt = d.die !== undefined ? `d${d.sides} ${d.die}${d.mod ? ` ${d.mod < 0 ? "−" : "+"} ${Math.abs(d.mod)}` : ""}` : d.text || q.formula;
      const crit = d.die !== undefined && d.sides === 20 ? (d.die === 20 ? "crit" : d.die === 1 ? "fumble" : null) : null;
      return { label: q.label, total: out[i], detail: txt, crit };
    });
    if (kind !== "hp") rows.sort((a, b) => b.total - a.total);
    this.cards.showList(reqs.length === 1 ? `${title}: ${reqs[0].label}` : title, rows);
    this.visibleTrays().forEach((tr) => tr.presentList(title, rows, null));
    const h = this.settings.dice.history || (this.settings.dice.history = []);
    h.unshift({ formula: reqs.length === 1 ? reqs[0].formula : `${reqs.length}d${sides[0] || 20}`, label: reqs.length === 1 ? reqs[0].label : `${title} ×${reqs.length}`, total: reqs.length === 1 ? out[0] : rows[0].total });
    h.splice(8);
    this.saveSoon();
    this.views().forEach((v) => v.trays.forEach((tr) => tr.history()));
    return out;
  }
  /** Throw n dice of one size, visibly in the tray when it's on screen. Returns the face values. */
  async throwHandful(n, sides) {
    const tray = this.visibleTrays()[0];
    const dr = this.diceRoller();
    if (tray && this.settings.dice.anim3d && !this.trayBusy) {
      this.trayBusy = true;
      try {
        this.visibleTrays().forEach((t) => t.prepare());
        if (dr) {
          this.placeDiceRenderer();
          const roller = await dr.getRoller(`${n}d${sides}`, "external");
          if (roller && typeof roller.roll === "function") {
            await roller.roll(true);
            const r = resultFromDiceRoller(roller);
            const vals = r && r.groups[0] ? r.groups[0].values : [];
            if (vals.length === n) return vals;
          }
        } else {
          const vals = Array.from({ length: n }, () => rollDie(sides));
          await new DiceStageRunner(tray).play(vals, sides);
          return vals;
        }
      } catch (e) {
        console.error("Game Master Interactive Screen: couldn't throw the dice in the tray", e);
      } finally {
        this.trayBusy = false;
      }
    }
    return Array.from({ length: n }, () => rollDie(sides));
  }

  /* ---- Dice ---- */

  roll(formula, label, source, kind = null, decorate = null) {
    const r = rollFormula(formula, label);
    if (!r) {
      new Notice(`"${formula}" isn't a dice formula.`);
      return null;
    }
    r.source = source;
    if (kind) r.kind = kind;
    if (decorate) decorate(r);
    this.presentRoll(r);
    return r;
  }
  /** Dice Roller plugin, if it's installed and has its roll API. */
  diceRoller() {
    const api = window.DiceRoller;
    return api && typeof api.getRoller === "function" ? api : null;
  }
  /**
   * Dice Roller throws its 3D dice on a full-window layer that it measures
   * when a throw starts. While a tray is visible, move that layer over the
   * tray (CSS on body) so its dice bounce inside the tray's borders.
   */
  placeDiceRenderer() {
    const tray = this.visibleTrays()[0];
    const body = document.body;
    if (!tray) {
      body.removeClass("gms-dice-in-tray");
      return null;
    }
    const r = tray.area.getBoundingClientRect();
    body.style.setProperty("--gms-tray-x", `${Math.round(r.left)}px`);
    body.style.setProperty("--gms-tray-y", `${Math.round(r.top)}px`);
    body.style.setProperty("--gms-tray-w", `${Math.round(r.width)}px`);
    body.style.setProperty("--gms-tray-h", `${Math.round(r.height)}px`);
    body.addClass("gms-dice-in-tray");
    return tray;
  }
  /** A roll from the tray: Dice Roller's real 3D dice inside the tray when possible, our own dice otherwise. */
  async rollInTray(formula, label, kind = null, decorate = null) {
    const dr = this.diceRoller();
    const tray = this.visibleTrays()[0];
    if (this.settings.dice.anim3d && dr && tray) {
      try {
        if (this.trayBusy) return null;
        this.trayBusy = true;
        this.placeDiceRenderer();
        this.visibleTrays().forEach((t) => t.prepare());
        const roller = await dr.getRoller(String(formula).replace(/\s+/g, ""), "external");
        if (roller && typeof roller.roll === "function") {
          await roller.roll(true);
          const r = resultFromDiceRoller(roller, label);
          if (r) {
            r.source = "tray";
            if (kind) r.kind = kind;
            if (decorate) decorate(r);
            await this.presentRoll(r, { rendered: true });
            return r;
          }
        }
      } catch (e) {
        console.error("Game Master Interactive Screen: Dice Roller roll failed, using built-in dice", e);
      } finally {
        this.trayBusy = false;
      }
    }
    return this.roll(formula, label, "tray", kind, decorate);
  }
  visibleTrays() {
    return this.views().flatMap((v) => v.trays).filter((tr) => tr.el.isConnected && tr.el.offsetParent !== null);
  }
  /** Tray shows it (3D if on) and the result card always pops up in the same place. */
  async presentRoll(r, opts = {}) {
    const h = this.settings.dice.history || (this.settings.dice.history = []);
    h.unshift({ formula: r.formula, label: r.label, total: r.total });
    h.splice(8);
    this.saveSoon();
    const trays = this.visibleTrays();
    if (trays.length) {
      const anim = !!this.settings.dice.anim3d && !opts.rendered;
      await Promise.all(trays.map((tr) => tr.present(r, anim).catch(() => {})));
    }
    const kind = String(r.kind || "").toLowerCase();
    const ri = this.ri();
    const canApply = ri && typeof ri.applyRoll === "function" && (kind === "damage" || kind === "healing");
    this.cards.show(r, canApply ? {
      apply: {
        label: kind === "healing" ? "Heal someone…" : "Apply damage…",
        run: () => ri.applyRoll({ total: r.total, kind, damageType: r.damageType || null, who: r.who || null, whoPath: r.whoPath || null, action: r.action || r.label || null, formula: r.formula, crit: critOf(r) }),
      },
    } : {});
    this.views().forEach((v) => v.trays.forEach((tr) => tr.history()));
    // For other plugins (e.g. Roll for Initiative applying damage): who rolled what
    this.app.workspace.trigger("game-master-screen:rolled", {
      total: r.total, formula: r.formula, label: r.label, source: r.source || null,
      who: r.who || null, whoPath: r.whoPath || null, action: r.action || null,
      kind: r.kind ? r.kind.toLowerCase() : null, damageType: r.damageType || null,
      crit: critOf(r),
      dice: r.groups.map((g) => ({ sides: g.sides, values: g.values.slice(), kept: g.kept.slice() })),
    });
  }
  /** Move a body-level menu overlay into the popup/tile that opened it, covering just that box. */
  adoptMenu(overlay) {
    const t = this.lastHostTouch;
    if (!t || Date.now() - t.t > 3000 || !t.host.isConnected) return;
    const host = t.host;
    const render = host.querySelector(".gms-render") || host;
    render.appendChild(overlay);
    host.addClass("gms-menu-open");
    const place = () => {
      overlay.style.setProperty("position", "absolute");
      overlay.style.setProperty("left", "0");
      overlay.style.setProperty("right", "0");
      overlay.style.setProperty("top", `${host.scrollTop}px`);
      overlay.style.setProperty("height", `${host.clientHeight}px`);
      overlay.style.setProperty("bottom", "auto");
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(host);
    const gone = new MutationObserver(() => {
      if (overlay.isConnected) return;
      host.removeClass("gms-menu-open");
      ro.disconnect();
      gone.disconnect();
    });
    gone.observe(render, { childList: true });
  }
  /** The note an element sits in: one of our popups/tiles, or an open note tab. { name, path } */
  noteOfElement(el) {
    let file = null;
    const tag = el.closest && el.closest("[data-gms-path]");
    if (tag) file = this.app.vault.getAbstractFileByPath(tag.getAttribute("data-gms-path"));
    if (!(file instanceof TFile)) {
      for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
        if (leaf.view && leaf.view.containerEl && leaf.view.containerEl.contains(el)) { file = leaf.view.file; break; }
      }
    }
    if (!(file instanceof TFile)) return null;
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    const name = (typeof fm.character_name === "string" && fm.character_name.trim()) || (typeof fm.name === "string" && fm.name.trim()) || file.basename;
    return { name, path: file.path };
  }

  async loadSettings() {
    const data = (await this.loadData()) || {};
    const s = Object.assign(clone(DEFAULT_SETTINGS), data);
    s.party = Object.assign({}, DEFAULT_SETTINGS.party, data.party || {});
    s.diary = Object.assign(clone(DEFAULT_SETTINGS.diary), data.diary || {});
    s.combat = Object.assign(clone(DEFAULT_SETTINGS.combat), data.combat || {});
    s.dice = Object.assign(clone(DEFAULT_SETTINGS.dice), data.dice || {});
    if (!Array.isArray(s.screens) || !s.screens.length) {
      // First run, or moving over from the sidebar version (party + pins)
      const tiles = [];
      if (data.showParty !== false) tiles.push({ id: uid(), type: "party", x: 0, y: 0, w: 560, h: 330 });
      tiles.push({ id: uid(), type: "diary", x: 580, y: 0, w: 440, h: 440 });
      let y = 350;
      for (const p of data.pins || []) {
        if (!p || !p.path) continue;
        tiles.push({ id: uid(), type: "note", path: p.path, x: 0, y, w: 240, h: 360, expanded: false });
        y += HEAD_H + GRID;
      }
      s.screens = [{ id: uid(), name: "Main", tiles }];
    }
    if (!s.screens.some((x) => x.id === s.activeScreen)) s.activeScreen = s.screens[0].id;
    for (const sc of s.screens) for (const t of sc.tiles) {
      if (t.cw !== undefined) continue;
      const size = TILE_SIZES[t.type] || TILE_SIZES.note;
      if (t.type === "party" || t.type === "diary") t.cw = 220;
      else if (t.expanded) t.cw = 240;
      else {
        t.cw = t.w || size.w;
        t.w = size.ew || size.w;
        if (!t.h || t.h < 120) t.h = size.h;
      }
    }
    for (const k of ["pins", "collapsed", "showParty", "showPins"]) delete s[k];
    if ((s.fieldsVersion || 1) < 2 && Array.isArray(s.fields)) {
      // v0.3 card: AC in a shield, passives and spellcasting in labelled groups
      const out = [];
      for (const f of s.fields) {
        const src = String(f.source || "");
        if (src === "armor_class" && (!f.display || f.display === "text")) out.push({ ...f, display: "shield" });
        else if (/^\$passive:/.test(src) && !f.group) {
          const name = src.replace(/^\$passive:\s*(Passive\s+)?/i, "");
          out.push({ ...f, label: name, group: "Passive" });
        } else if (src === "@Spells.spell_save_dc") {
          out.push({ label: "Save DC", display: "text", source: "$spelldc", group: "Spellcasting" });
          if (!s.fields.some((x) => /spellattack|spell_attack_bonus/.test(x.source || ""))) out.push({ label: "Attack", display: "text", source: "$spellattack", group: "Spellcasting" });
        } else out.push(f);
      }
      s.fields = out;
    }
    s.fieldsVersion = 2;
    this.settings = s;
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  views() {
    return this.app.workspace.getLeavesOfType(VIEW_TYPE).map((l) => l.view).filter((v) => v instanceof GmScreenView);
  }
  refreshViews() {
    this.views().forEach((v) => v.refreshAll());
  }

  async activate(reveal = true) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.settings.openIn === "right" ? this.app.workspace.getRightLeaf(false) : this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    if (reveal) this.app.workspace.revealLeaf(leaf);
    return leaf.view instanceof GmScreenView ? leaf.view : null;
  }

  lastMarkdownFile() {
    const f = this.app.workspace.getActiveFile();
    return f && f.extension === "md" ? f : null;
  }

  /* ---- Screens ---- */

  activeScreen() {
    const s = this.settings;
    return s.screens.find((x) => x.id === s.activeScreen) || s.screens[0];
  }
  async addScreen(name) {
    const sc = { id: uid(), name, tiles: [] };
    this.settings.screens.push(sc);
    this.settings.activeScreen = sc.id;
    await this.saveSettings();
    this.refreshViews();
  }
  async saveTemplate(sc, name) {
    const s = this.settings;
    s.templates = s.templates || [];
    const data = screenToJson(sc);
    const old = s.templates.find((x) => x.name === name);
    if (old) old.tiles = data.tiles;
    else s.templates.push({ id: uid(), name, tiles: data.tiles });
    await this.saveSettings();
    new Notice(`Template "${name}" saved. Use + next to the tabs to start a screen from it.`);
  }
  async addScreenFrom(data) {
    const parsed = screenFromJson({ gmScreen: 1, name: data.name, tiles: data.tiles });
    if (!parsed) return;
    const sc = { id: uid(), name: parsed.name, tiles: parsed.tiles };
    this.settings.screens.push(sc);
    this.settings.activeScreen = sc.id;
    await this.saveSettings();
    this.refreshViews();
    new Notice(`Screen "${sc.name}" added with ${sc.tiles.length} tiles.`);
  }
  async duplicateScreen(sc) {
    const copy = clone(sc);
    copy.id = uid();
    copy.name = `${sc.name} (copy)`;
    copy.tiles.forEach((t) => (t.id = uid()));
    const i = this.settings.screens.indexOf(sc);
    this.settings.screens.splice(i + 1, 0, copy);
    this.settings.activeScreen = copy.id;
    await this.saveSettings();
    this.refreshViews();
  }
  async moveScreen(i, d) {
    const a = this.settings.screens;
    const j = i + d;
    if (j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    await this.saveSettings();
    this.views().forEach((v) => v.renderTabs());
  }
  async deleteScreen(id) {
    const s = this.settings;
    if (s.screens.length <= 1) return;
    s.screens = s.screens.filter((x) => x.id !== id);
    if (s.activeScreen === id) s.activeScreen = s.screens[0].id;
    await this.saveSettings();
    this.refreshViews();
  }

  /* ---- Tiles ---- */

  async addTile(spec) {
    const sc = this.activeScreen();
    const size = TILE_SIZES[spec.type] || TILE_SIZES.note;
    const view = this.views()[0];
    const width = (view && view.boardWrap && view.boardWrap.clientWidth) || 1000;
    const tile = { id: uid(), x: 0, y: 0, w: size.ew || size.w, h: size.h, cw: Math.min(size.w, 240), expanded: false };
    for (const k of ["type", "path", "heading", "level", "mapIndex", "mapId", "mapLine", "blockId", "title", "text", "color", "items"]) if (spec[k] !== undefined) tile[k] = spec[k];
    const box = tileBox(tile);
    Object.assign(tile, freeSpot(sc.tiles, box.w, box.h, width));
    sc.tiles.push(tile);
    await this.saveSettings();
    if (!view) await this.activate();
    this.views().forEach((v) => v.renderBoard());
    const label = this.views()[0] ? this.views()[0].tileTitle(tile) : tile.type;
    new Notice(`Added ${label} to "${sc.name}"`);
  }
  addMapTile(file, hit) {
    this.addTile({ type: "map", path: file.path, mapIndex: hit.index, mapId: hit.block.id || undefined, mapLine: hit.block.start, title: `${file.basename} – map` });
  }
  updateTile(t, patch, rerender) {
    Object.assign(t, patch);
    this.saveSoon();
    this.views().forEach((v) => (rerender ? v.renderBoard() : v.sizeBoard()));
  }
  async moveTile(t, screenId) {
    const from = this.settings.screens.find((s) => s.tiles.includes(t));
    const to = this.settings.screens.find((s) => s.id === screenId);
    if (!from || !to) return;
    from.tiles = from.tiles.filter((x) => x !== t);
    const b = tileBox(t);
    const pos = freeSpot(to.tiles, b.w, b.h, 1000);
    Object.assign(t, pos);
    to.tiles.push(t);
    await this.saveSettings();
    this.views().forEach((v) => v.renderBoard());
  }
  async removeTile(t) {
    for (const s of this.settings.screens) s.tiles = s.tiles.filter((x) => x !== t);
    await this.saveSettings();
    this.views().forEach((v) => v.renderBoard());
  }

  /* ---- Combat ---- */

  /**
   * Every party the combat builder can start from: party tiles (this screen
   * first), the character sheet's party groups, and the party from settings.
   * [{ label, files }]
   */
  partySources() {
    const out = [];
    const seen = new Set();
    const add = (label, files) => {
      const key = files.map((f) => f.path).join("|");
      if (!files.length || seen.has(key)) return;
      seen.add(key);
      out.push({ label, files });
    };
    const active = this.activeScreen();
    const screens = [active].concat(this.settings.screens.filter((x) => x !== active));
    for (const sc of screens) {
      for (const t of sc.tiles.filter((x) => x.type === "party")) {
        const name = t.title || "Party";
        add(sc === active ? `${name} (this screen)` : `${name} (${sc.name})`, this.party.members(t));
      }
    }
    for (const g of this.party.sheetGroups()) {
      add(`Sheet group: ${g.name}`, (g.members || []).map((m) => this.party.resolveNote(m)).filter(Boolean));
    }
    add("Party from settings", this.party.members(null));
    return out;
  }
  async createCombat(spec) {
    const folder = String(this.settings.combat.folder || "").replace(/\/+$/, "");
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const base = cleanFileName(spec.name) || "Encounter";
    let path = normalizePath(`${folder ? folder + "/" : ""}${base}.md`);
    for (let n = 2; this.app.vault.getAbstractFileByPath(path); n++) path = normalizePath(`${folder ? folder + "/" : ""}${base} ${n}.md`);
    const id = uid().slice(0, 6);
    const link = (f) => this.app.metadataCache.fileToLinktext(f, path, true);
    const block = combatBlock({
      name: spec.name,
      id,
      players: spec.players.map(link),
      creatures: spec.creatures.map((c) => ({ ...c, link: c.file ? link(c.file) : undefined })),
    });
    const file = await this.app.vault.create(path, `# ${spec.name}\n\n\`\`\`roll-initiative\n${block}\n\`\`\`\n`);
    await this.addTile({ type: "combat", path: file.path, blockId: id, title: spec.name });
    return file;
  }

  /* ---- Party tiles ---- */

  /** The first edit of a party tile copies the current party into the tile's own list. */
  ownParty(t) {
    if (!Array.isArray(t.members)) t.members = this.party.members(t).map((f) => f.path);
    return t.members;
  }
  pickCharacter(t) {
    if (!t) t = this.activeScreen().tiles.find((x) => x.type === "party");
    if (!t) return new Notice("Add a Party tile first (Add → Party).");
    new CharacterPicker(this, this.party.members(t).map((f) => f.path), (f) => this.partyAdd(t, f.path), "Add a character to this party").open();
  }
  async partyAdd(t, path) {
    const list = this.ownParty(t);
    if (!list.includes(path)) list.push(path);
    await this.saveSettings();
    this.views().forEach((v) => v.renderPartyTiles());
  }
  async partyRemove(t, path) {
    t.members = this.ownParty(t).filter((p) => p !== path);
    await this.saveSettings();
    this.views().forEach((v) => v.renderPartyTiles());
  }
  async partyMove(t, path, d) {
    const list = this.ownParty(t);
    const i = list.indexOf(path);
    const j = i + d;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    await this.saveSettings();
    this.views().forEach((v) => v.renderPartyTiles());
  }

  /** The heading the cursor is under: { heading, level }. */
  headingAt(text, line) {
    const lines = String(text).split("\n");
    for (let i = Math.min(line, lines.length - 1); i >= 0; i--) {
      const body = stripQuotes(lines[i], quoteDepth(lines[i]));
      const m = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(body);
      if (m) return { heading: cleanHeading(m[2]), level: m[1].length };
    }
    return null;
  }
  mapAt(text, line) {
    const blocks = findMapBlocks(text);
    const index = blocks.findIndex((b) => line >= b.start && line <= b.end);
    return index < 0 ? null : { index, block: blocks[index] };
  }

  /* ---- Session diary ---- */

  diaryFolderFiles() {
    const folder = String(this.settings.diary.folder || "").replace(/\/+$/, "");
    const af = folder ? this.app.vault.getAbstractFileByPath(folder) : this.app.vault.getRoot();
    if (!(af instanceof TFolder)) return [];
    return af.children.filter((f) => f instanceof TFile && f.extension === "md");
  }
  diaryFile() {
    const p = this.settings.diary.current;
    const f = p && this.app.vault.getAbstractFileByPath(p);
    return f instanceof TFile ? f : null;
  }
  nextSessionNumber() {
    const names = this.diaryFolderFiles().map((f) => f.basename);
    return lastSessionNumber(names, this.settings.diary.pattern || "") + 1;
  }
  sessionVars(vals) {
    const d = this.settings.diary;
    const date = moment(vals.date || undefined);
    return {
      vars: { number: padNum(vals.number, Number(d.pad) || 0), title: vals.title || "" },
      fmt: (f) => date.format(f || d.dateFormat || "YYYY-MM-DD"),
    };
  }
  sessionFileName(vals) {
    const { vars, fmt } = this.sessionVars(vals);
    let name = fillTokens(this.settings.diary.pattern || "Session {{number}} - {{title}}", vars, fmt);
    if (!vals.title) name = name.replace(/\s*[-–—:|]\s*$/, "");
    return cleanFileName(name) || `Session ${vars.number}`;
  }
  async createSession(vals, notes) {
    const d = this.settings.diary;
    const { vars, fmt } = this.sessionVars(vals);
    const folder = String(d.folder || "").replace(/\/+$/, "");
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
    const path = normalizePath(`${folder ? folder + "/" : ""}${this.sessionFileName(vals)}.md`);
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`${path} already exists.`);
      return;
    }
    let template = d.templateText || "";
    if (d.templatePath) {
      const tf = this.app.metadataCache.getFirstLinkpathDest(stripLink(d.templatePath).replace(/\.md$/, ""), "");
      if (tf instanceof TFile) template = await this.app.vault.read(tf);
      else new Notice(`Template note "${d.templatePath}" not found; using the template text from settings.`);
    }
    const file = await this.app.vault.create(path, insertNotes(fillTokens(template, vars, fmt), notes));
    d.current = file.path;
    if (notes && notes.trim()) d.draft = "";
    await this.saveSettings();
    this.refreshViews();
    new Notice(`Created ${file.basename}`);
    const v = this.views()[0];
    if (v) v.openPopup({ type: "note", path: file.path });
  }
  async appendNotes(file, notes) {
    if (!notes || !notes.trim()) return new Notice("Write something first.");
    await this.app.vault.process(file, (data) => insertNotes(data, notes));
    this.settings.diary.draft = "";
    this.settings.diary.current = file.path;
    await this.saveSettings();
    this.refreshViews();
    new Notice(`Added your notes to ${file.basename}`);
  }
  pickSession(onPick) {
    const files = this.diaryFolderFiles().sort((a, b) => b.stat.ctime - a.stat.ctime);
    new SessionPicker(this, files.length ? files : this.app.vault.getMarkdownFiles(), onPick).open();
  }
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const DISPLAY_TYPES = { text: "Number / text", shield: "Shield (top right)", bar: "Bar (current / max)", tags: "Tags (list)", pips: "Pips (spell slots)" };
const PARTY_MODES = { sheetGroup: "Party group from character sheet", folder: "All notes in a folder", tag: "All notes with a tag", list: "Hand-picked notes" };

class GmScreenSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async save(refresh = true) {
    await this.plugin.saveSettings();
    if (refresh) this.plugin.refreshViews();
  }

  display() {
    const { containerEl: el } = this;
    const s = this.plugin.settings;
    el.empty();
    el.addClass("gms-settings");

    /* Game system */
    new Setting(el).setName("Game system").setHeading();
    let pick = s.preset;
    new Setting(el)
      .setName("Preset")
      .setDesc("Fills in the party fields, name/portrait properties and search categories for a game system. Applying replaces your current fields and categories.")
      .addDropdown((d) => {
        for (const [id, p] of Object.entries(PRESETS)) d.addOption(id, p.name);
        d.setValue(s.preset).onChange((v) => (pick = v));
      })
      .addButton((b) => b.setButtonText("Apply").onClick(async () => {
        this.plugin.applyPreset(pick);
        await this.save();
        this.display();
      }));

    const sheetOn = !!(this.app.plugins.plugins && this.app.plugins.plugins[SHEET_ID]);
    new Setting(el)
      .setName("Use One DnD Character Sheet data")
      .setDesc(sheetOn ? "Reads passives, spell DC, conditions and spell slots from the sheet's companion notes." : "The One DnD Character Sheet plugin is not enabled in this vault.")
      .addToggle((t) => t.setValue(!!s.useSheet).onChange(async (v) => { s.useSheet = v; await this.save(); this.display(); }));

    /* Party */
    new Setting(el).setName("Party").setHeading();
    new Setting(el)
      .setName("Who is in the party")
      .addDropdown((d) => {
        for (const [k, label] of Object.entries(PARTY_MODES)) d.addOption(k, label);
        d.setValue(s.party.mode).onChange(async (v) => {
          s.party.mode = v;
          s.party.value = "";
          await this.save();
          this.display();
        });
      });
    const mode = s.party.mode;
    if (mode === "sheetGroup") {
      const groups = this.plugin.party.sheetGroups();
      new Setting(el)
        .setName("Party group")
        .setDesc(groups.length ? "Groups are set up in the character sheet's settings." : "No party groups found. Create one in the One DnD Character Sheet settings, or pick another option above.")
        .addDropdown((d) => {
          for (const g of groups) d.addOption(g.name, `${g.name} (${(g.members || []).length})`);
          d.setValue(s.party.value || (groups[0] && groups[0].name) || "").onChange(async (v) => { s.party.value = v; await this.save(); });
        });
    } else if (mode === "folder" || mode === "tag") {
      new Setting(el)
        .setName(mode === "folder" ? "Folder" : "Tag")
        .setDesc(mode === "folder" ? "Vault path, e.g. Campaign/Players" : "e.g. pc or Player")
        .addText((t) => t.setValue(s.party.value).onChange(async (v) => { s.party.value = v.trim(); await this.save(); }));
    } else {
      new Setting(el)
        .setName("Characters")
        .setDesc("One note name per line.")
        .addTextArea((t) => {
          t.setValue(s.party.value).onChange(async (v) => { s.party.value = v; await this.save(); });
          t.inputEl.rows = 5;
        });
    }
    new Setting(el)
      .setName("Compact cards")
      .setDesc("Smaller cards, more per row.")
      .addToggle((t) => t.setValue(!!s.compactParty).onChange(async (v) => { s.compactParty = v; await this.save(); }));
    for (const [k, name, desc] of [
      ["nameKey", "Name property", "Shown as the card title; the note name is used when it's empty."],
      ["imageKey", "Portrait property", "An image link or file name."],
    ]) {
      new Setting(el).setName(name).setDesc(desc).addText((t) => t.setValue(s[k] || "").onChange(async (v) => { s[k] = v.trim(); await this.save(); }));
    }
    new Setting(el)
      .setName("Subtitle properties")
      .setDesc("Comma-separated, e.g. class, level")
      .addText((t) => t.setValue((s.subtitleKeys || []).join(", ")).onChange(async (v) => {
        s.subtitleKeys = v.split(",").map((x) => x.trim()).filter(Boolean);
        await this.save();
      }));

    /* Fields */
    new Setting(el).setName("Party fields").setHeading();
    el.createDiv({ cls: "setting-item-description gms-help", text: "Source can be a property of the character note (armor_class), a sheet companion property (@Abilities.str_mod), or a sheet value: $passive:Passive Perception, $spelldc, $spellattack, $conditions, $slots. Number fields with the same group are shown together under the group's name." });
    s.fields.forEach((f, i) => {
      const row = new Setting(el).setClass("gms-field-row");
      row.addText((t) => t.setPlaceholder("Label").setValue(f.label || "").onChange(async (v) => { f.label = v; await this.save(); }));
      row.addDropdown((d) => {
        for (const [k, l] of Object.entries(DISPLAY_TYPES)) d.addOption(k, l);
        d.setValue(f.display || "text").onChange(async (v) => { f.display = v; await this.save(); this.display(); });
      });
      row.addText((t) => t.setPlaceholder(f.display === "bar" ? "Current" : "Source").setValue(f.source || "").onChange(async (v) => { f.source = v.trim(); await this.save(); }));
      if (f.display === "bar") {
        row.addText((t) => t.setPlaceholder("Max").setValue(f.max || "").onChange(async (v) => { f.max = v.trim(); await this.save(); }));
        row.addText((t) => t.setPlaceholder("Temp (optional)").setValue(f.temp || "").onChange(async (v) => { f.temp = v.trim(); await this.save(); }));
      }
      if (!f.display || f.display === "text") {
        row.addText((t) => t.setPlaceholder("Group (optional)").setValue(f.group || "").onChange(async (v) => { f.group = v.trim() || undefined; await this.save(); }));
      }
      row.addExtraButton((b) => b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(async () => {
        if (i === 0) return;
        [s.fields[i - 1], s.fields[i]] = [s.fields[i], s.fields[i - 1]];
        await this.save();
        this.display();
      }));
      row.addExtraButton((b) => b.setIcon("trash").setTooltip("Remove").onClick(async () => {
        s.fields.splice(i, 1);
        await this.save();
        this.display();
      }));
    });
    new Setting(el).addButton((b) => b.setButtonText("Add field").onClick(async () => {
      s.fields.push({ label: "", display: "text", source: "" });
      await this.save(false);
      this.display();
    }));

    /* Session diary */
    new Setting(el).setName("Session diary").setHeading();
    const d = s.diary;
    const example = () => {
      try { return `Next note: ${this.plugin.sessionFileName({ number: this.plugin.nextSessionNumber(), title: "The long road" })}.md`; } catch (e) { return ""; }
    };
    const ex = el.createDiv({ cls: "setting-item-description gms-help" });
    const refreshEx = () => ex.setText(example());
    new Setting(el)
      .setName("Folder")
      .setDesc("Where new session notes are saved.")
      .addText((t) => t.setPlaceholder("Campaign/Sessions").setValue(d.folder || "").onChange(async (v) => { d.folder = v.trim(); await this.save(false); refreshEx(); }));
    new Setting(el)
      .setName("Note name")
      .setDesc("Use {{number}}, {{title}} and {{date}}. The number continues from the highest one already in the folder.")
      .addText((t) => t.setValue(d.pattern || "").onChange(async (v) => { d.pattern = v; await this.save(false); refreshEx(); }));
    new Setting(el)
      .setName("Number digits")
      .setDesc("2 gives Session 07 instead of Session 7.")
      .addDropdown((dd) => {
        for (const n of ["0", "2", "3"]) dd.addOption(n, n === "0" ? "No padding" : `${n} digits`);
        dd.setValue(String(d.pad || 0)).onChange(async (v) => { d.pad = Number(v); await this.save(false); refreshEx(); });
      });
    new Setting(el)
      .setName("Date format")
      .setDesc("For {{date}}, e.g. YYYY-MM-DD or D. M. YYYY. Use {{date:FORMAT}} for a different format in one place.")
      .addText((t) => t.setValue(d.dateFormat || "").onChange(async (v) => { d.dateFormat = v.trim() || "YYYY-MM-DD"; await this.save(false); refreshEx(); }));
    new Setting(el)
      .setName("Template note")
      .setDesc("Optional. A note used as the starting content. Leave empty to use the template text below.")
      .addText((t) => t.setPlaceholder("Templates/Session").setValue(d.templatePath || "").onChange(async (v) => { d.templatePath = v.trim(); await this.save(false); }));
    new Setting(el)
      .setName("Template text")
      .setDesc("What a new session note looks like. {{number}}, {{title}} and {{date}} are filled in; your session notes go where {{notes}} is (or at the end).")
      .setClass("gms-template-setting")
      .addTextArea((t) => {
        t.setValue(d.templateText || "").onChange(async (v) => { d.templateText = v; await this.save(false); });
        t.inputEl.rows = 12;
        t.inputEl.addClass("gms-template-text");
      });
    el.appendChild(ex);
    refreshEx();

    /* Search */
    new Setting(el).setName("Search").setHeading();
    new Setting(el)
      .setName("Search inside notes")
      .setDesc("Also searches the full text of notes when titles, headings and properties don't give enough results. Slower in big vaults.")
      .addToggle((t) => t.setValue(!!s.fullText).onChange(async (v) => { s.fullText = v; await this.save(false); }));
    new Setting(el)
      .setName("Results shown")
      .addSlider((sl) => sl.setLimits(10, 100, 5).setValue(s.resultLimit).setDynamicTooltip().onChange(async (v) => { s.resultLimit = v; await this.save(false); }));

    new Setting(el).setName("Search categories").setHeading();
    el.createDiv({ cls: "setting-item-description gms-help", text: "Filter buttons next to the search bar. A note belongs to a category when it's in one of its folders or has one of its tags (comma-separated)." });
    s.categories.forEach((c, i) => {
      const row = new Setting(el).setClass("gms-field-row");
      row.addText((t) => t.setPlaceholder("Name").setValue(c.name || "").onChange(async (v) => { c.name = v.trim(); await this.save(); }));
      row.addText((t) => {
        t.setPlaceholder("Folders").setValue((c.folders || []).join(", ")).onChange(async (v) => {
          c.folders = v.split(",").map((x) => x.trim()).filter(Boolean);
          await this.save();
        });
        t.inputEl.addClass("gms-wide");
      });
      row.addText((t) => t.setPlaceholder("Tags").setValue((c.tags || []).join(", ")).onChange(async (v) => {
        c.tags = v.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean);
        await this.save();
      }));
      row.addExtraButton((b) => b.setIcon("arrow-up").setTooltip("Move up").setDisabled(i === 0).onClick(async () => {
        if (i === 0) return;
        [s.categories[i - 1], s.categories[i]] = [s.categories[i], s.categories[i - 1]];
        await this.save();
        this.display();
      }));
      row.addExtraButton((b) => b.setIcon("trash").setTooltip("Remove").onClick(async () => {
        s.categories.splice(i, 1);
        await this.save();
        this.display();
      }));
    });
    new Setting(el).addButton((b) => b.setButtonText("Add category").onClick(async () => {
      s.categories.push({ name: "New", folders: [], tags: [] });
      await this.save();
      this.display();
    }));

    /* Dice */
    new Setting(el).setName("Dice").setHeading();
    new Setting(el)
      .setName("3D dice in the tray")
      .setDesc("Dice thrown in the tray use the Dice Roller plugin's 3D dice when it's installed. Off shows only the final number. The result card in the bottom-right corner appears either way.")
      .addToggle((t) => t.setValue(!!s.dice.anim3d).onChange(async (v) => { s.dice.anim3d = v; await this.save(); }));
    new Setting(el)
      .setName("Show Dice Roller rolls")
      .setDesc("Rolls you click on the character sheet or in statblocks (made by the Dice Roller plugin) roll in the tray and show the result card. For attack and damage buttons on the sheet, turn on its Dice Roller integration in the character sheet's settings.")
      .addToggle((t) => t.setValue(!!s.dice.catchDiceRoller).onChange(async (v) => { s.dice.catchDiceRoller = v; await this.save(false); }));
    const dr = this.app.plugins.plugins && this.app.plugins.plugins["obsidian-dice-roller"];
    if (dr && dr.data) {
      new Setting(el)
        .setName("Dice Roller's own 3D dice")
        .setDesc("3D dice for rolls you click on the character sheet and in statblocks. While a dice tray is on screen they roll inside the tray; otherwise across the whole window. Off: those rolls show only the result. Same switch as in Dice Roller's own settings.")
        .addToggle((t) => t.setValue(!!dr.data.renderer).onChange(async (v) => {
          dr.data.renderer = v;
          if (typeof dr.saveSettings === "function") await dr.saveSettings();
          new Notice(v ? "Dice Roller's 3D dice are on." : "Dice Roller's 3D dice are off.");
        }));
    }

    new Setting(el)
      .setName("Roll for Initiative's rolls in the tray")
      .setDesc("Initiative (and rolled monster HP) from Roll for Initiative are thrown in the dice tray, all at once, and listed on one result card.")
      .addToggle((t) => t.setValue(s.dice.initiativeInTray !== false).onChange(async (v) => {
        s.dice.initiativeInTray = v;
        await this.save(false);
        if (v) this.plugin.connectInitiative();
        else this.plugin.unhookInitiative();
      }));

    /* Combat */
    new Setting(el).setName("Combat").setHeading();
    new Setting(el)
      .setName("Concentration checks")
      .setDesc("When a concentrating character or creature takes damage, a card shows the Constitution save DC with a button to roll it. Concentrating characters are marked on party cards and in the combat bar.")
      .addToggle((t) => t.setValue(s.concentration !== false).onChange(async (v) => { s.concentration = v; await this.save(); }));
    new Setting(el)
      .setName("Combat bar")
      .setDesc("While a Roll for Initiative fight is running, a bar under the search shows the round, whose turn it is and who's next, with turn buttons. Party cards highlight whose turn it is.")
      .addToggle((t) => t.setValue(s.showCombatBar !== false).onChange(async (v) => { s.showCombatBar = v; await this.save(); this.plugin.views().forEach((vw) => vw.renderCombatBar()); }));
    new Setting(el)
      .setName("Encounter folder (without Roll for Initiative 1.5)")
      .setDesc("Only used by the screen's own combat builder. With Roll for Initiative 1.5 or newer, Add → Combat opens its wizard and uses its encounter folder.")
      .addText((t) => t.setPlaceholder("Encounters").setValue(s.combat.folder || "").onChange(async (v) => { s.combat.folder = v.trim(); await this.save(false); }));

    /* Screen templates */
    new Setting(el).setName("Screen templates").setHeading();
    const tpls = s.templates || [];
    if (!tpls.length) el.createDiv({ cls: "setting-item-description gms-help", text: "None yet. Right-click a screen tab → Save as template…" });
    tpls.forEach((tp, i) => {
      new Setting(el)
        .setName(tp.name)
        .setDesc(`${tp.tiles.length} tiles`)
        .addExtraButton((b) => b.setIcon("upload").setTooltip("Export").onClick(() => new ExportScreenModal(this.plugin, { name: tp.name, tiles: tp.tiles }).open()))
        .addExtraButton((b) => b.setIcon("trash").setTooltip("Delete template").onClick(async () => {
          tpls.splice(i, 1);
          await this.save(false);
          this.display();
        }));
    });

    /* Screen */
    new Setting(el).setName("Screen").setHeading();
    new Setting(el)
      .setName("Open in")
      .setDesc("Where the screen opens when it isn't open yet. You can also drag its tab anywhere.")
      .addDropdown((dd) => dd.addOption("main", "Main area (new tab)").addOption("right", "Right sidebar").setValue(s.openIn || "main").onChange(async (v) => { s.openIn = v; await this.save(false); }));
    new Setting(el)
      .setName("Open on startup")
      .addToggle((t) => t.setValue(!!s.openOnStart).onChange(async (v) => { s.openOnStart = v; await this.save(false); }));
  }
}

GmScreenPlugin.prototype.applyPreset = function (id) {
  const p = PRESETS[id];
  if (!p) return;
  this.settings.preset = id;
  this.settings.nameKey = p.nameKey;
  this.settings.subtitleKeys = p.subtitleKeys.slice();
  this.settings.imageKey = p.imageKey;
  this.settings.fields = clone(p.fields);
  this.settings.categories = clone(p.categories);
  this.settings.useSheet = id === "dnd2024";
  if (id !== "dnd2024" && this.settings.party.mode === "sheetGroup") this.settings.party = { mode: "folder", value: "" };
};

module.exports = GmScreenPlugin;
module.exports.__test = {
  norm, scoreEntry, computeSlots, stripLink, getPath, flattenValues, toInt, PRESETS,
  parseFormula, rollFormula, withAdvantage, critOf, breakdown, resultFromDiceRoller, visualDice, SHAPES, DiceStage,
  ResponsiveNotes, rollContext, rollWhat, snapResize, screenToJson, screenFromJson, concentrationDC, isConcentration, insertNotes, spellcasting, findInitiativeBlock, combatBlock, extractSection, findMapBlocks, mapMarkdown, pickMap, cleanHeading, fillTokens, lastSessionNumber, padNum, cleanFileName, freeSpot, tileBox, isOpenTile, snapToTiles,
};
