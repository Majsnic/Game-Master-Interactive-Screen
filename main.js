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
/** Obsidian's HTML sanitizer (falls back to plain text on very old versions). */
const sanitizeHTMLToDom = obsidian.sanitizeHTMLToDom || ((html) => { const d = document.createDocumentFragment(); d.append(String(html).replace(/<[^>]+>/g, "")); return d; });

const VIEW_TYPE = "game-master-screen-view";
const SHEET_ID = "onednd-character-sheet";
const DEFAULT_SHEET_DATA_FOLDER = "Compendium/Character Sheet Data"; // only if the sheet doesn't report its own dataFolder

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
  sound: { volume: 80, fade: 1200 },
  session: { minutes: 240, warn: 30, chime: true, startedAt: null, elapsed: 0, warned: false, over: false },
  showCombatBar: true,
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
  part: { w: 240, h: 300, ew: 420 },
  map: { w: 220, h: 440, ew: 600 },
  party: { w: 560, h: 330 },
  combat: { w: 240, h: 520, ew: 520 },
  dice: { w: 420, h: 400 },
  sticky: { w: 240, h: 230 },
  checklist: { w: 270, h: 320 },
  sound: { w: 360, h: 300 },
  clocks: { w: 400, h: 480 },
  tables: { w: 460, h: 520 },
  diary: { w: 440, h: 440 },
};
const TILE_ICONS = { note: "file-text", section: "heading", part: "text-select", map: "map", party: "users", diary: "notebook-pen", combat: "swords", dice: "dices", sticky: "sticky-note", checklist: "list-checks", sound: "audio-lines", clocks: "hourglass", tables: "dices" };
const ALWAYS_OPEN = ["party", "diary", "combat", "dice", "sticky", "checklist", "sound", "clocks", "tables"];
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
 * Several Roll for Initiative fights running together (RI 1.8 "linked"
 * initiatives) as one fight: `states` are each fight's api.getState()
 * results in list order, `turnRef` = { path, id } of the fight that has the
 * turn. In the other fights the `current` marker only shows who acts next
 * there, so it's cleared. Everyone who can act is put in one order
 * (initiative, then fight order, then their order in the fight), the same
 * order Roll for Initiative walks with Next turn; `next` is who follows the
 * current combatant there. Returns null when fewer than two fights are running.
 */
function combineFights(states, turnRef, skipDown = true) {
  const same = (st, r) => !!st && !!r && st.sourcePath === r.path && (st.id || "") === (r.id || "");
  const run = (states || []).filter((x) => x && x.running && !x.ended);
  if (run.length < 2) return null;
  const turn = run.find((x) => same(x, turnRef)) || run.find((x) => !x.waiting) || run[0];
  const canAct = (c) => !c.off && !(skipDown && !c.player && typeof c.hp === "number" && c.hp <= 0);
  const all = [];
  run.forEach((f, fi) => (f.combatants || []).forEach((c, ci) => {
    all.push({ ...c, current: f === turn && !!c.current, fight: f.name || "", fightPath: f.sourcePath, fightId: f.id || null, fi, ci });
  }));
  const order = all.filter((c) => canAct(c) || c.current).sort((a, b) => {
    const ia = a.init ?? -Infinity;
    const ib = b.init ?? -Infinity;
    return ia !== ib ? (ib > ia ? 1 : -1) : a.fi - b.fi || a.ci - b.ci;
  });
  const i = order.findIndex((c) => c.current);
  let next = null;
  for (let k = 1; k <= order.length; k++) {
    const c = order[((i < 0 ? -1 : i) + k) % order.length];
    if (c && !c.current) { next = c; break; }
  }
  const cur = all.find((c) => c.current);
  return {
    ...turn,
    combatants: all,
    current: cur ? cur.name : null,
    currentFight: turn.name || "",
    next: next ? next.name : null,
    nextFight: next ? next.fight : null,
    nextPath: next ? next.fightPath : null,
    linked: true,
    fights: run.map((f) => ({ name: f.name || "", sourcePath: f.sourcePath, id: f.id || null, turn: f === turn })),
  };
}

/**
 * The pieces of a note you can put on the screen on their own, in order:
 * headings, blocks with a ^id, callouts, statblocks, pictures and maps.
 */
function noteParts(text) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  const counts = {};
  let fence = null;
  let fenceStart = -1;
  for (let i = frontmatterEnd(lines); i < lines.length; i++) {
    const raw = lines[i];
    const d = quoteDepth(raw);
    const line = stripQuotes(raw, d);
    if (fence) {
      if (line.trim().startsWith(fence.mark) && !line.trim().replace(/[`~]/g, "")) {
        if (fence.lang === "statblock") {
          const body = lines.slice(fenceStart + 1, i).map((l) => stripQuotes(l, d)).join("\n");
          const nm = /^\s*name:\s*["']?(.+?)["']?\s*$/m.exec(body) || /^\s*monster:\s*["']?(.+?)["']?\s*$/m.exec(body);
          counts.statblock = (counts.statblock || 0) + 1;
          out.push({ kind: "statblock", index: counts.statblock - 1, name: nm ? nm[1].trim() : `Statblock ${counts.statblock}`, line: fenceStart });
        }
        fence = null;
      }
      continue;
    }
    const fm = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (fm) {
      fence = { mark: fm[1], lang: fm[2].toLowerCase() };
      fenceStart = i;
      if (fence.lang === "zoommap") { counts.map = (counts.map || 0) + 1; out.push({ kind: "map", index: counts.map - 1, line: i }); }
      continue;
    }
    const h = d === 0 && /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { out.push({ kind: "heading", heading: cleanHeading(h[2]), level: h[1].length, line: i }); continue; }
    const c = /^\[!([^\]\s|]+)[^\]]*\][+-]?\s*(.*)$/.exec(line.trim());
    if (c && d >= 1 && (i === 0 || quoteDepth(lines[i - 1]) < d || !stripQuotes(lines[i - 1], d).trim())) {
      counts.callout = (counts.callout || 0) + 1;
      out.push({ kind: "callout", index: counts.callout - 1, type: c[1].toLowerCase(), title: cleanHeading(c[2].replace(/<br\s*\/?>/gi, " — ").replace(/<[^>]+>/g, "")) || c[1].charAt(0).toUpperCase() + c[1].slice(1), depth: d, line: i });
    }
    const b = /(?:^|\s)\^([A-Za-z0-9-]+)\s*$/.exec(line);
    if (b) {
      const own = !line.replace(/\^[A-Za-z0-9-]+\s*$/, "").trim();
      let pv = own ? "" : line.replace(/\s*\^[A-Za-z0-9-]+\s*$/, "");
      if (own) for (let j = i - 1; j >= 0 && !pv; j--) pv = stripQuotes(lines[j], quoteDepth(lines[j])).trim();
      if (own && /^\|/.test(pv)) {
        // a table: show its header row, not the last row
        let j = i - 1;
        while (j > 0 && /^\|/.test(stripQuotes(lines[j - 1], quoteDepth(lines[j - 1])).trim())) j--;
        pv = "Table: " + stripQuotes(lines[j], quoteDepth(lines[j])).trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" · ");
      }
      out.push({ kind: "block", id: b[1], preview: cleanHeading(pv.replace(/^\s*([-*+]|\d+\.)\s+/, "").replace(/^\|/, "")).slice(0, 60), line: i });
    }
    for (const m of line.matchAll(/!\[\[([^\]|#]+?\.(?:png|jpe?g|webp|gif|svg|avif|bmp))(?:[|#][^\]]*)?\]\]|!\[[^\]]*\]\(([^)\s]+?\.(?:png|jpe?g|webp|gif|svg|avif|bmp))\)/gi)) {
      const target = decodeURI(m[1] || m[2]);
      if (!out.some((x) => x.kind === "image" && x.target === target)) out.push({ kind: "image", target, line: i });
    }
  }
  return out;
}
/** The markdown of one part (block / callout / statblock); null when it's gone. */
function notePartMarkdown(text, part) {
  const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
  const parts = noteParts(text);
  const same = parts.filter((x) => x.kind === part.kind);
  let hit = null;
  if (part.kind === "block") hit = same.find((x) => x.id === part.ref);
  else if (part.kind === "statblock" || part.kind === "callout") {
    const key = part.kind === "statblock" ? "name" : "title";
    hit = same.find((x) => x[key] === part.ref) || same[part.index || 0] || null;
  }
  if (!hit) return null;
  const at = hit.line;
  const d = quoteDepth(lines[at]);
  const bare = (k) => stripQuotes(lines[k], d);
  if (part.kind === "statblock") {
    let j = at + 1;
    while (j < lines.length && !/^\s*(`{3,}|~{3,})\s*$/.test(bare(j))) j++;
    return lines.slice(at, j + 1).map((l, k) => bare(at + k)).join("\n");
  }
  if (part.kind === "callout") {
    let j = at + 1;
    while (j < lines.length && quoteDepth(lines[j]) >= d && stripQuotes(lines[j], d - 1).trim()) j++;
    return lines.slice(at, j).map((l) => stripQuotes(l, d - 1)).join("\n");
  }
  // block: the line with the id (a list item / single line), or the paragraph / table above a lone ^id
  const own = !bare(at).replace(/\^[A-Za-z0-9-]+\s*$/, "").trim();
  let from = at;
  let to = at;
  if (own) {
    to = at - 1;
    while (to >= 0 && !bare(to).trim()) to--;
    from = to;
    while (from > 0 && bare(from - 1).trim() && !/^#{1,6}\s/.test(bare(from - 1))) from--;
  } else if (!/^\s*([-*+]|\d+\.)\s/.test(bare(at))) {
    while (from > 0 && bare(from - 1).trim() && !/^#{1,6}\s/.test(bare(from - 1)) && !/^\s*([-*+]|\d+\.)\s/.test(bare(from - 1))) from--;
  }
  if (to < from) return null;
  return lines.slice(from, to + 1).map((l, k) => bare(from + k)).join("\n").replace(/\s*\^[A-Za-z0-9-]+\s*$/, "");
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

const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "svg", "avif", "bmp"];
const isImage = (f) => f instanceof TFile && IMAGE_EXT.includes(String(f.extension || "").toLowerCase());
/** Where TTRPG Tools - Maps keeps an image's markers: "map.png.markers.json" or "map.markers.json". */
function markersCandidates(imagePath) {
  const p = String(imagePath || "");
  const dot = p.lastIndexOf(".");
  const base = dot > p.lastIndexOf("/") ? p.slice(0, dot) : p;
  return [`${p}.markers.json`, `${base}.markers.json`];
}
/** The map image a markers.json belongs to (its active / first base). */
function imageFromMarkers(json) {
  let o = json;
  try { if (typeof o === "string") o = JSON.parse(o); } catch (e) { return null; }
  if (!o || typeof o !== "object") return null;
  const pathOf = (b) => (typeof b === "string" ? b : b && typeof b === "object" ? b.path || b.image || null : null);
  return pathOf(o.activeBase) || (Array.isArray(o.bases) && o.bases.map(pathOf).find(Boolean)) || pathOf(o.image) || null;
}
/** A zoommap block for an image + markers file, filling its tile. */
function imageMapMarkdown(id, image, markers) {
  return "```zoommap\n" + [
    `id: ${JSON.stringify(id)}`,
    `image: ${JSON.stringify(image)}`,
    `markers: ${JSON.stringify(markers)}`,
    "width: 100%",
    "height: 100%",
    "resizable: false",
    "responsive: false",
  ].join("\n") + "\n```";
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
 * A spell note's "Damage / Effect" (e.g. "2d8 Healing + spellcasting ability modifier",
 * "1d10 Force") → { kind: "Healing" | "Damage", damageType }. One DnD Character Sheet
 * spell rows show only the dice since sheet 1.7, so the type has to come from the note.
 */
function spellEffectKind(effect) {
  const eff = String(effect === undefined || effect === null ? "" : effect).trim();
  if (!eff || !/\d+d\d+/i.test(eff)) return null;
  if (/heal|léč|regain/i.test(eff)) return { kind: "Healing", damageType: null };
  const rest = eff.replace(/^\s*(?:\d+d\d+)(?:\s*[+-]\s*(?:\d+d\d+|\d+))*\s*/i, "").split(/\s*[+(,;]\s*|\s+-\s+/)[0].trim();
  const type = rest.replace(/\s+damage$/i, "").trim();
  return { kind: "Damage", damageType: type && type.length < 25 && /^[A-Za-zÀ-ž ]+$/.test(type) ? type : null };
}

/**
 * Who rolled and what for, read from around a clicked Dice Roller button:
 * the character sheet's Actions/Spells rows (action name, hit cell or
 * damage cell, damage type) or a statblock action. `noteOf(el)` finds the
 * note the button sits in. Returns { who, whoPath, action, kind, damageType }.
 */
const DAMAGE_TYPE_RE = /^(acid|bludgeoning|cold|fire|force|lightning|necrotic|piercing|poison|psychic|radiant|slashing|thunder|healing|kyselin|drtiv|chlad|oheň|ohe[nň]|síl|blesk|nekrot|bodn|jed|psych|zář|seč|hrom|léč)/i;
function rollContext(el, noteOf) {
  const clean = (x) => String(x || "").replace(/\s+/g, " ").replace(/[.:]\s*$/, "").trim();
  const ctx = { who: null, whoPath: null, action: null, kind: null, damageType: null, link: null };
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
      const link = row.querySelector(".action-name a.internal-link, a.internal-link");
      if (link && !link.contains(el)) ctx.link = link.getAttribute("data-href") || link.getAttribute("href") || null;
      const own = clean((cell.textContent || "").replace(el.textContent || "", ""));
      if (idx === 0 && isD20) ctx.kind = "Attack";
      else {
        // An old-style separate "Type" column, if there is one (sheet 1.8 dropped it; the
        // range cell is also a <b>, so only accept real damage-type words from it)
        const types = Array.from(row.querySelectorAll(".action-stat > b")).map((b) => clean(b.textContent)).filter((x) => DAMAGE_TYPE_RE.test(x));
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
  /** A plain notice card (session reminder, timer done). tone: "warn" | "over" | "". */
  showMessage({ title, text, tone }) {
    const stack = this.ensure();
    const card = stack.createDiv({ cls: `gms-roll-card is-message${tone ? ` is-${tone}` : ""}` });
    const top = card.createDiv({ cls: "gms-roll-card-top" });
    top.createDiv({ cls: "gms-roll-card-label", text: title });
    card.createDiv({ cls: "gms-roll-card-msg", text });
    while (stack.childElementCount > 4) stack.firstElementChild.remove();
    card.addEventListener("click", () => card.remove());
    window.setTimeout(() => card.addClass("is-leaving"), 60000);
    card.addEventListener("transitionend", () => { if (card.hasClass("is-leaving")) card.remove(); });
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

class TextAreaPrompt extends Modal {
  constructor(app, title, value, onSubmit, help) {
    super(app);
    this.t = title;
    this.value = value || "";
    this.onSubmit = onSubmit;
    this.help = help;
  }
  onOpen() {
    this.titleEl.setText(this.t);
    if (this.help) this.contentEl.createDiv({ cls: "setting-item-description", text: this.help });
    const ta = this.contentEl.createEl("textarea", { cls: "gms-json-box", attr: { spellcheck: "false" } });
    ta.value = this.value;
    const row = this.contentEl.createDiv({ cls: "modal-button-container" });
    row.createEl("button", { text: "Save", cls: "mod-cta" }).onclick = () => { this.close(); this.onSubmit(ta.value); };
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
    setTimeout(() => ta.focus(), 0);
  }
  onClose() { this.contentEl.empty(); }
}

/** "What do you want from this note?" – the whole note or one part of it. */
class NotePartPicker extends FuzzySuggestModal {
  constructor(plugin, file, parts) {
    super(plugin.app);
    this.plugin = plugin;
    this.file = file;
    this.parts = [{ kind: "note" }, ...parts];
    this.setPlaceholder(`Add from ${file.basename}: the whole note, a heading, a block, a picture, a statblock…`);
  }
  getItems() { return this.parts; }
  getItemText(x) {
    switch (x.kind) {
      case "note": return `📄 Whole note`;
      case "heading": return `${"  ".repeat(Math.max(0, x.level - 1))}# ${x.heading}`;
      case "block": return `¶ ^${x.id}${x.preview ? ` — ${x.preview}` : ""}`;
      case "callout": return `${"   ".repeat(Math.max(0, (x.depth || 1) - 1))}💬 ${x.title}  (${x.type})`;
      case "statblock": return `🐉 Statblock: ${x.name}`;
      case "image": return `🖼 Picture: ${x.target.split("/").pop()}`;
      case "map": return `🗺 Map ${x.index + 1}`;
      default: return x.kind;
    }
  }
  onChooseItem(x) { this.plugin.addNotePart(this.file, x); }
}

class ListPicker extends FuzzySuggestModal {
  constructor(app, items, text, onPick, placeholder) {
    super(app);
    this.items = items;
    this.text = text;
    this.onPick = onPick;
    this.setPlaceholder(placeholder || "");
  }
  getItems() { return this.items; }
  getItemText(it) { return this.text(it); }
  onChooseItem(it) { this.onPick(it); }
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

/* ================= Clocks (same text format as the Tabletop Clocks plugin) ================= */

const CK_COLORS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];
const CK_FRAC = /(\d+)\s*\/\s*(\d+)/g;
const CK_VS = /\s+vs\.?\s+/i;
const CK_HEAD = /^#{1,6}\s+(.*)$/;
const CK_LINK = /\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/;
const CK_T = "\\d+:\\d{2}(?::\\d{2})?";
const CK_SW = new RegExp(`^(.+?):\\s*(${CK_T})(?:\\s+of\\s+(${CK_T}))?$`, "i");
const CK_CT = /^(.+?):\s*([-−]?\d+)(?:\s+of\s+(\d+))?$/i;
const CK_FENCE = /^((?:\s*>)*\s*)(`{3,}|~{3,})\s*clocks\b/;
const ckClamp = (v, a, b) => Math.max(a, Math.min(b, v));
function ckLastFrac(str) {
  let m = null;
  for (const x of str.matchAll(CK_FRAC)) m = x;
  return m;
}
function ckName(str) {
  let name = str;
  let link;
  const m = CK_LINK.exec(name);
  if (m) {
    link = m[1].trim();
    name = name.replace(m[0], m[2] ? m[2].trim() : link);
  }
  return { name: name.replace(/\s+/g, " ").trim(), link };
}
function ckColorTail(str) {
  const m = /^(.*?)(\s+(\S+))?\s*$/.exec(str);
  const c = m[3] && m[3].toLowerCase();
  return m[1] && c && CK_COLORS.includes(c) ? { rest: m[1], color: c, tail: m[2] } : { rest: str.trimEnd(), tail: "" };
}
const ckSecs = (str) => str.split(":").reduce((a, x) => a * 60 + parseInt(x, 10), 0);
function ckTime(sec) {
  const i = Math.max(0, Math.floor(sec));
  const h = Math.floor(i / 3600);
  const m = Math.floor((i % 3600) / 60);
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(i % 60)}` : `${m}:${p(i % 60)}`;
}
/** A counter ("Torches: 6 of 10") or stopwatch ("Ritual: 0:00 of 10:00") line. */
function ckLine(line) {
  const { rest, color, tail } = ckColorTail(line.trim());
  let m = CK_SW.exec(rest);
  if (m) {
    const n = ckName(m[1]);
    if (!n.name) return null;
    const sw = { ...n, seconds: ckSecs(m[2]) };
    if (m[3]) sw.limit = ckSecs(m[3]);
    if (color) sw.color = color;
    return { head: m[1], tail, stopwatch: sw };
  }
  m = CK_CT.exec(rest);
  if (m) {
    const n = ckName(m[1]);
    if (!n.name) return null;
    const c = { ...n, value: parseInt(m[2].replace("−", "-"), 10) };
    if (m[3]) c.max = parseInt(m[3], 10);
    if (color) c.color = color;
    return { head: m[1], tail, counter: c };
  }
  return null;
}
/** One progress clock: "Alarm 2/6 red". */
function ckClock(str, def, part = 0) {
  let t = str.trim();
  if (!t) return null;
  let color;
  const w = t.split(/\s+/);
  const last = w[w.length - 1].toLowerCase();
  if (w.length > 1 && CK_COLORS.includes(last)) {
    color = last;
    t = w.slice(0, -1).join(" ");
  }
  const f = ckLastFrac(t);
  let size = def;
  let filled = 0;
  if (f) {
    size = ckClamp(parseInt(f[2], 10), 2, 12);
    filled = ckClamp(parseInt(f[1], 10), 0, size);
    t = (t.slice(0, f.index) + t.slice(f.index + f[0].length)).trim();
  }
  let link;
  const l = CK_LINK.exec(t);
  if (l) {
    link = l[1].trim();
    t = t.replace(l[0], l[2] ? l[2].trim() : link);
  }
  const name = t.replace(/\s+/g, " ").replace(/[:\-–—]\s*$/, "").trim();
  return name ? { name, link, filled, size, color, part, written: !!f } : null;
}
function parseClocks(text, def = 4) {
  const out = [];
  String(text || "").split("\n").forEach((raw, i) => {
    const str = raw.trim();
    if (!str) return;
    const h = CK_HEAD.exec(str);
    if (h) return out.push({ kind: "heading", index: i, text: h[1].trim() });
    const l = ckLine(str);
    if (l && l.counter) return out.push({ kind: "counter", index: i, counter: l.counter });
    if (l && l.stopwatch) return out.push({ kind: "stopwatch", index: i, stopwatch: l.stopwatch });
    const cl = str.split(CK_VS).slice(0, 2).map((x, k) => ckClock(x, def, k)).filter(Boolean);
    if (cl.length) out.push({ kind: "clocks", index: i, clocks: cl });
  });
  return out;
}
/** New value for a counter (number) or stopwatch (seconds) on line `index`. */
function ckSetValue(text, index, v) {
  const lines = text.split("\n");
  const raw = lines[index];
  const l = raw === undefined ? null : ckLine(raw);
  if (!l) return text;
  const ind = /^\s*/.exec(raw)[0];
  const val = l.counter
    ? `${v}${l.counter.max !== undefined ? ` of ${l.counter.max}` : ""}`
    : `${ckTime(v)}${l.stopwatch.limit !== undefined ? ` of ${ckTime(l.stopwatch.limit)}` : ""}`;
  lines[index] = `${ind}${l.head.trim()}: ${val}${l.tail}`;
  return lines.join("\n");
}
/** Fill `n` segments of clock `part` (0, or 1 for the right side of "A vs B") on line `index`. */
function ckSetFill(text, index, part, n, def) {
  const lines = text.split("\n");
  const raw = lines[index];
  if (raw === undefined) return text;
  const ind = /^\s*/.exec(raw)[0];
  const parts = raw.trim().split(CK_VS);
  const seps = raw.trim().match(new RegExp(CK_VS.source, "gi")) || [];
  const p = parts[part];
  if (p === undefined) return text;
  const c = ckClock(p, def, part);
  if (!c) return text;
  const v = ckClamp(n, 0, c.size);
  const f = ckLastFrac(p);
  if (f) parts[part] = p.slice(0, f.index) + `${v}/${c.size}` + p.slice(f.index + f[0].length);
  else {
    const m = /^(.*?)(\s+(?:red|orange|yellow|green|cyan|blue|purple|pink))?\s*$/i.exec(p);
    parts[part] = `${m[1]} ${v}/${c.size}${m[2] || ""}`;
  }
  lines[index] = ind + parts.map((x, k) => (k ? seps[k - 1] || " vs " : "") + x).join("");
  return lines.join("\n");
}
/** Append what was typed in the add box (several separated by ; or new lines). */
function ckAdd(text, input, def) {
  const lines = input.split(/\n|;/).map((x) => x.trim()).filter(Boolean)
    .map((x) => (ckLine(x) ? x : x.split(CK_VS).map((p) => { const c = ckClock(p, def); return c && !c.written ? ckSetFill(p, 0, 0, 0, def) : p; }).join(" vs ")));
  if (!lines.length) return text;
  const base = String(text || "").replace(/\s+$/, "");
  return (base ? base + "\n" : "") + lines.join("\n");
}
/** Remove one clock: in "A vs B" only that side goes, otherwise the whole line. */
function ckRemovePart(text, index, part) {
  const lines = String(text || "").split("\n");
  const raw = lines[index];
  if (raw === undefined) return text;
  const parts = raw.trim().split(CK_VS);
  if (parts.length < 2 || part === undefined) return ckRemoveLine(text, index);
  lines[index] = /^\s*/.exec(raw)[0] + parts[part ? 0 : 1].trim();
  return lines.join("\n");
}
function ckRemoveLine(text, index) {
  const l = String(text || "").split("\n");
  l.splice(index, 1);
  return l.join("\n");
}
/** ```clocks blocks of a note: [{ start, end, prefix, body }]. */
function findClockBlocks(md) {
  const lines = String(md || "").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CK_FENCE.exec(lines[i]);
    if (!m) continue;
    const pre = m[1];
    const fence = m[2];
    let j = i + 1;
    while (j < lines.length) {
      const rest = lines[j].slice(pre.length).trim();
      if (rest.startsWith(fence) && !rest.replace(/[`~]/g, "")) break;
      j++;
    }
    if (j >= lines.length) break;
    out.push({ start: i, end: j, prefix: pre, body: lines.slice(i + 1, j).map((l) => l.slice(pre.length)).join("\n") });
    i = j;
  }
  return out;
}
function replaceClockBlock(md, n, fn) {
  const b = findClockBlocks(md)[n];
  if (!b) return null;
  const lines = String(md).split("\n");
  const body = fn(b.body).replace(/\s+$/, "").split("\n").map((l) => b.prefix + l);
  lines.splice(b.start + 1, b.end - b.start - 1, ...body);
  return lines.join("\n");
}
/** "4", "4h", "3:30", "3h 30m", "210m", "90 min" → minutes (null if unreadable). */
function parseDuration(str) {
  const t = String(str || "").trim().toLowerCase().replace(",", ".");
  if (!t) return null;
  let m = /^(\d+):(\d{1,2})$/.exec(t);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = /^(?:(\d+(?:\.\d+)?)\s*h(?:ours?|od(?:in[ay]?)?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?$/.exec(t);
  if (m && (m[1] || m[2])) return Math.round((parseFloat(m[1] || "0") * 60) + parseInt(m[2] || "0", 10));
  m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) {
    const n = parseFloat(m[1]);
    return n <= 12 ? Math.round(n * 60) : Math.round(n);
  }
  return null;
}
/** 9300 s → "2:35:00"; minutes → "4 h", "3 h 30 min". */
function hms(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, "0");
  return `${Math.floor(sec / 3600)}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}
function hm(ms) {
  const min = Math.max(0, Math.ceil(ms / 60000));
  return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}
function durationText(min) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h && m ? `${h} h ${m} min` : h ? `${h} h` : `${m} min`;
}

/* ================= Random tables (Randomness plugin) ================= */

const STARTER_FOLDER = "GM Screen";
const STARTER_FILES = {
  "GM Screen Loot.rdm": "// GM Screen Loot - starter loot & treasure tables for the Game Master Interactive Screen.\n// Coins and item counts follow the D&D 2024 treasure guidelines by challenge rating.\n// Edit freely: add your own items, change weights (the number before the colon), add tables.\n// Several things in one result are separated by \"; \" so the GM screen can hand them out item by item.\n\nTitle: GM Screen Loot\n\n// ---------- Individual treasure (what one creature carries) ----------\n\nTable: LootIndividualCR0to4\n3: {3d6} gp\n1: {3d6} gp; [@Trinket]\n1: {3d6} gp; [@PocketJunk]\n\nTable: LootIndividualCR5to10\n3: {2d8*10} gp\n1: {2d8*10} gp; [@Gem10]\n1: {2d8*10} gp; [@Trinket]\n\nTable: LootIndividualCR11to16\n3: {2d10*10} pp\n1: {2d10*10} pp; [@Gem50]\n1: {2d10*10} pp; [@Art25]\n\nTable: LootIndividualCR17plus\n3: {2d8*100} pp\n1: {2d8*100} pp; [@Gem100]\n1: {2d8*100} pp; [@Art250]\n\n// ---------- Treasure hoards (a lair, a vault, a dragon's bed) ----------\n\nTable: LootHoardCR0to4\n2: {2d4*100} gp; [@HoardMagicCR0to4]\n1: {2d4*100} gp; [@Gem10]; [@Gem10]; [@HoardMagicCR0to4]\n1: {2d4*100} gp; [@Art25]; [@HoardMagicCR0to4]\n1: {2d4*100} gp; [@Gem50]; [@Trinket]; [@HoardMagicCR0to4]\n\nTable: LootHoardCR5to10\n2: {8d10*100} gp; [@HoardMagicCR5to10]\n1: {8d10*100} gp; [@Gem50]; [@Gem50]; [@Gem100]; [@HoardMagicCR5to10]\n1: {8d10*100} gp; [@Art250]; [@HoardMagicCR5to10]\n1: {8d10*100} gp; [@Gem500]; [@Art25]; [@HoardMagicCR5to10]\n\nTable: LootHoardCR11to16\n2: {8d8*10000} gp; [@HoardMagicCR11to16]\n1: {8d8*10000} gp; [@Gem500]; [@Gem500]; [@Gem1000]; [@HoardMagicCR11to16]\n1: {8d8*10000} gp; [@Art750]; [@Art750]; [@HoardMagicCR11to16]\n1: {8d8*10000} gp; [@Gem1000]; [@Art2500]; [@HoardMagicCR11to16]\n\nTable: LootHoardCR17plus\n2: {6d10*10000} gp; [@HoardMagicCR17plus]\n1: {6d10*10000} gp; [@Gem1000]; [@Gem5000]; [@HoardMagicCR17plus]\n1: {6d10*10000} gp; [@Art2500]; [@Art7500]; [@HoardMagicCR17plus]\n1: {6d10*10000} gp; [@Gem5000]; [@Gem5000]; [@Art7500]; [@HoardMagicCR17plus]\n\n// Magic items in a hoard: CR 0-4 1d4-1, CR 5-10 1d3, CR 11-16 1d4, CR 17+ 1d6.\nTable: HoardMagicCR0to4\n1: no magic items\n1: [@MagicTier1]\n1: [@MagicTier1]; [@MagicTier1]\n1: [@MagicTier1]; [@MagicTier1]; [@MagicTier1]\n\nTable: HoardMagicCR5to10\n1: [@MagicTier2]\n1: [@MagicTier2]; [@MagicTier2]\n1: [@MagicTier2]; [@MagicTier2]; [@MagicTier2]\n\nTable: HoardMagicCR11to16\n1: [@MagicTier3]\n1: [@MagicTier3]; [@MagicTier3]\n1: [@MagicTier3]; [@MagicTier3]; [@MagicTier3]\n1: [@MagicTier3]; [@MagicTier3]; [@MagicTier3]; [@MagicTier3]\n\nTable: HoardMagicCR17plus\n1: [@MagicTier4]\n1: [@MagicTier4]; [@MagicTier4]\n1: [@MagicTier4]; [@MagicTier4]; [@MagicTier4]\n1: [@MagicTier4]; [@MagicTier4]; [@MagicTier4]; [@MagicTier4]\n1: [@MagicTier4]; [@MagicTier4]; [@MagicTier4]; [@MagicTier4]; [@MagicTier4]\n1: [@MagicTier4]; [@MagicTier4]; [@MagicTier4]; [@MagicTier4]; [@MagicTier4]; [@MagicTier4]\n\nTable: MagicTier1\n4: [@MagicCommon]\n2: [@MagicUncommon]\n\nTable: MagicTier2\n1: [@MagicCommon]\n4: [@MagicUncommon]\n2: [@MagicRare]\n\nTable: MagicTier3\n3: [@MagicRare]\n2: [@MagicVeryRare]\n\nTable: MagicTier4\n3: [@MagicVeryRare]\n2: [@MagicLegendary]\n\n// ---------- Magic items by rarity ----------\n\nTable: MagicCommon\n3: Potion of Healing\nPotion of Climbing\n4: Spell Scroll (Cantrip or 1st Level)\nBead of Nourishment\nBoots of False Tracks\nCandle of the Deep\nCast-Off Armor\nCharlatan's Die\nClockwork Amulet\nEnduring Spellbook\nHat of Wizardry\nHorn of Silent Alarm\nLock of Trickery\nMoon-Touched Sword\nMystery Key\nOrb of Direction\nPerfume of Bewitching\nPipe of Smoke Monsters\nPole of Collapsing\nRope of Mending\nRuby of the War Mage\nShield of Expression\nSmoldering Armor\nStaff of Birdcalls\nStaff of Flowers\nTankard of Sobriety\nUnbreakable Arrow\nVeteran's Cane\nWand of Pyrotechnics\nWand of Smiles\n\nTable: MagicUncommon\n2: Potion of Greater Healing\nPotion of Fire Breath\nPotion of Water Breathing\n3: Spell Scroll (2nd-3rd Level)\n2: +1 [@MagicWeapon]\n+1 Shield\nAlchemy Jug\nAmulet of Proof against Detection and Location\nBag of Holding\nBoots of Elvenkind\nBracers of Archery\nCloak of Elvenkind\nCloak of Protection\nDriftglobe\nEyes of the Eagle\nGauntlets of Ogre Power\nGoggles of Night\nHat of Disguise\nHeadband of Intellect\nImmovable Rod\nJavelin of Lightning\nMithral Armor\nPearl of Power\nRing of Jumping\nRing of Water Walking\nRope of Climbing\nSending Stones\nWand of Magic Detection\nWand of Magic Missiles\nWand of Web\nWinged Boots\n\nTable: MagicRare\n2: Potion of Superior Healing\nPotion of Invisibility\n2: Spell Scroll (4th-5th Level)\n2: +2 [@MagicWeapon]\n+1 Armor\n+2 Shield\nAmulet of Health\nBelt of Dwarvenkind\nBoots of Speed\nBracers of Defense\nCape of the Mountebank\nCloak of Displacement\nDagger of Venom\nElemental Gem\nFlame Tongue\nHorseshoes of Speed\nMace of Smiting\nNecklace of Fireballs\nPeriapt of Proof against Poison\nRing of Evasion\nRing of Protection\nRing of Spell Storing\nStaff of Healing\nSword of Wounding\nWand of Fireballs\nWand of Lightning Bolts\n\nTable: MagicVeryRare\n2: Potion of Supreme Healing\n3: Spell Scroll (6th-8th Level)\n2: +3 [@MagicWeapon]\n+2 Armor\n+3 Shield\nAnimated Shield\nBelt of Fire Giant Strength\nCarpet of Flying\nCrystal Ball\nDancing Sword\nDwarven Thrower\nManual of Bodily Health\nNine Lives Stealer\nRing of Regeneration\nRod of Absorption\nStaff of Fire\nStaff of Thunder and Lightning\nSword of Sharpness\nTome of Clear Thought\nWand of Polymorph\n\nTable: MagicLegendary\nSpell Scroll (9th Level)\n+3 Armor\nBelt of Cloud Giant Strength\nCloak of Invisibility\nDefender\nHoly Avenger\nIoun Stone of Mastery\nLuck Blade\nRing of Djinni Summoning\nRing of Three Wishes\nRobe of the Archmagi\nRod of Lordly Might\nScarab of Protection\nStaff of the Magi\nVorpal Sword\nWell of Many Worlds\n\nTable: MagicWeapon\n3: Longsword\n2: Shortsword\n2: Dagger\n2: Longbow\nShortbow\nBattleaxe\nWarhammer\nGreatsword\nGreataxe\nRapier\nScimitar\nMace\nSpear\nLight Crossbow\nHeavy Crossbow\nHandaxe\nJavelin\nQuarterstaff\n\n// ---------- Gems by value ----------\n\nTable: GemAny\n5: [@Gem10]\n4: [@Gem50]\n3: [@Gem100]\n2: [@Gem500]\n1: [@Gem1000]\n\nTable: Gem10\nAzurite (10 gp)\nBanded agate (10 gp)\nBlue quartz (10 gp)\nEye agate (10 gp)\nHematite (10 gp)\nLapis lazuli (10 gp)\nMalachite (10 gp)\nMoss agate (10 gp)\nObsidian (10 gp)\nRhodochrosite (10 gp)\nTiger eye (10 gp)\nTurquoise (10 gp)\n\nTable: Gem50\nBloodstone (50 gp)\nCarnelian (50 gp)\nChalcedony (50 gp)\nChrysoprase (50 gp)\nCitrine (50 gp)\nJasper (50 gp)\nMoonstone (50 gp)\nOnyx (50 gp)\nRock crystal (50 gp)\nSardonyx (50 gp)\nRose quartz (50 gp)\nZircon (50 gp)\n\nTable: Gem100\nAmber (100 gp)\nAmethyst (100 gp)\nChrysoberyl (100 gp)\nCoral (100 gp)\nGarnet (100 gp)\nJade (100 gp)\nJet (100 gp)\nPearl (100 gp)\nSpinel (100 gp)\nTourmaline (100 gp)\n\nTable: Gem500\nAlexandrite (500 gp)\nAquamarine (500 gp)\nBlack pearl (500 gp)\nBlue spinel (500 gp)\nPeridot (500 gp)\nTopaz (500 gp)\n\nTable: Gem1000\nBlack opal (1000 gp)\nBlue sapphire (1000 gp)\nEmerald (1000 gp)\nFire opal (1000 gp)\nOpal (1000 gp)\nStar ruby (1000 gp)\nStar sapphire (1000 gp)\nYellow sapphire (1000 gp)\n\nTable: Gem5000\nBlack sapphire (5000 gp)\nDiamond (5000 gp)\nJacinth (5000 gp)\nRuby (5000 gp)\n\n// ---------- Art objects by value ----------\n\nTable: ArtAny\n4: [@Art25]\n3: [@Art250]\n2: [@Art750]\n1: [@Art2500]\n\nTable: Art25\nPewter tankard with a hunting scene (25 gp)\nCarved bone hair comb (25 gp)\nSilver thimble on a fine chain (25 gp)\nPainted wooden icon of a local saint (25 gp)\nEmbroidered silk purse (25 gp)\nBrass compass with a cracked lid (25 gp)\nCopper bracelet set with river glass (25 gp)\nSmall oil portrait of a stern noblewoman (25 gp)\nSet of carved ivory gaming dice (25 gp)\nVelvet masquerade mask with silver thread (25 gp)\n\nTable: Art250\nGold signet ring of a fallen house (250 gp)\nSilver hand mirror with an engraved back (250 gp)\nBronze statuette of a rearing horse (250 gp)\nTapestry of a famous battle (250 gp)\nJade-handled letter opener (250 gp)\nSilk shawl woven with gold thread (250 gp)\nSilver music box playing a lullaby (250 gp)\nEnamelled snuffbox with a pastoral scene (250 gp)\nIvory chess set in a lacquered case (250 gp)\nSilver circlet with small pearls (250 gp)\n\nTable: Art750\nGold chalice rimmed with garnets (750 gp)\nElectrum ceremonial dagger (750 gp)\nMarble bust of a forgotten emperor (750 gp)\nLute of dark wood with mother-of-pearl inlay (750 gp)\nSilver reliquary with a saint's finger bone (750 gp)\nPlatinum brooch shaped like a dragonfly (750 gp)\nGilded hourglass filled with crushed sapphire (750 gp)\nObsidian mask with gold leaf (750 gp)\n\nTable: Art2500\nGold necklace set with fire opals (2500 gp)\nMasterwork painting of a royal wedding (2500 gp)\nPlatinum armband with a sapphire (2500 gp)\nGold astrolabe with jewelled stars (2500 gp)\nCrystal decanter with a platinum stopper (2500 gp)\nEmbroidered royal mantle with moonstones (2500 gp)\n\nTable: Art7500\nJewelled gold crown (7500 gp)\nPlatinum ring with a star ruby (7500 gp)\nGold reliquary set with emeralds (7500 gp)\nJade throne miniature with solid gold figures (7500 gp)\nBejewelled ivory drinking horn (7500 gp)\n\n// ---------- Small finds ----------\n\nTable: Trinket\nA tiny brass key that fits no lock anyone has found\nA glass eye that sometimes seems to blink\nA lock of silver hair tied with a black ribbon\nA wooden token carved with a tavern's name\nA child's tin soldier missing its sword\nA pressed flower inside a folded love letter\nA coin from a kingdom no one remembers\nA small bell that makes no sound\nA map fragment showing half of an island\nA bone whistle shaped like a bird\nA ring of woven grass that never wilts\nA pouch of seven perfectly round black pebbles\nA cracked monocle with a gold rim\nA wax seal bearing an unknown coat of arms\nA vial of sand that is always warm\nA thimble engraved with the word \"remember\"\nA deck of cards missing every queen\nA feather that falls upward when dropped\nA wooden spoon carved with a face\nA candle stub that smells of the sea\nA silver button from a guard's uniform\nA smooth stone with a hole through the middle\nA miniature portrait of a stranger\nA tooth from some large, unknown beast\nA prayer bead from a temple that burned down\nA jar holding a single, very old firefly\nA brass gear from an unknown machine\nAn IOU for 100 gold, signed by a duke\n\nTable: PocketJunk\nA half-eaten apple\nA ball of string and two buttons\nA crumpled shopping list\nA wooden comb with missing teeth\nA pair of loaded dice\nA whetstone\nA stub of chalk\nA small knife with a bent tip\nA tin of boot grease\nA bit of dried meat wrapped in cloth\nA cheap brass ring\nA letter from a worried mother\nA pipe and a pinch of tobacco\nA lucky rabbit's foot\nA crude drawing of a dragon\nA wanted poster with a familiar face\n",
  "GM Screen Everyday.rdm": "// GM Screen Everyday - quick tables a GM needs at the table.\n// Edit freely: change lines, add new ones, change weights (the number before the colon).\n\nTitle: GM Screen Everyday\n\nTable: TavernName\nThe [@TavernAdj] [@TavernNoun]\nThe [@TavernNoun] and [@TavernNoun]\n2: The [@TavernAdj] [@TavernNoun]\n\nTable: TavernAdj\nGilded\nRusty\nDrunken\nLaughing\nSleeping\nPrancing\nCrooked\nSilver\nWandering\nHowling\nSly\nBroken\nMerry\nLonely\nGolden\nBlack\n\nTable: TavernNoun\nGoat\nDragon\nBarrel\nLantern\nGriffon\nStag\nKettle\nOwl\nAnchor\nWyvern\nHound\nBoar\nHarp\nMermaid\nCrown\nCandle\n\nTable: NPCQuirk\nSpeaks in a whisper, as if someone is listening\nLaughs at their own jokes before finishing them\nConstantly polishes a ring that isn't there\nCalls everyone \"friend\", even enemies\nSniffs every item before buying it\nCounts things out loud when nervous\nQuotes a holy book, usually wrongly\nRefuses to sit with their back to a door\nWears far too much perfume\nCollects other people's buttons\nAnswers questions with questions\nHums the same three notes over and over\nVery proud of a dreadful moustache\nInsists on shaking hands with both hands\nTells a different story about every scar\nAlways hungry, always eating\nPretends to be much older than they are\nNever uses anyone's name, only nicknames\nSpeaks to their pet as if it's a business partner\nExtremely polite, until money comes up\n\nTable: Rumour\nThe old mill burns lights at night, but no one lives there.\nA merchant's caravan vanished on the north road three days ago.\nThe captain of the guard takes bribes in the bathhouse.\nSomeone has been buying every crow in the market.\nThe temple bell rang by itself at midnight.\nA noble's daughter ran away with a travelling bard.\nThere's a map to a dwarven vault for sale, cheap.\nThe well water tastes of iron since the last storm.\nWolves have been seen walking on two legs near the forest.\nA new tax collector arrives next week, and he's brought soldiers.\nThe blacksmith forged a sword he refuses to sell.\nChildren have been drawing the same strange symbol on walls.\nThe harbour master is paying double for brave sailors.\nA hermit in the hills claims he can speak to the dead.\nSomeone poisoned the mayor's prize horse.\n\nTable: Complication\nAn old enemy recognises one of the heroes.\nThe weather turns sharply worse.\nA bridge, road or door is out - they need another way.\nA guard demands papers no one has.\nSomeone important is in the wrong place at the wrong time.\nAn ally sends a desperate message.\nThe thing they came for has already been taken.\nA fire breaks out nearby.\nA crowd gathers and gets in the way.\nEquipment breaks at the worst moment.\nA rival group is after the same goal.\nA child follows them and won't go home.\nThe authorities arrive early.\nA trusted contact turns out to be lying.\nThe heroes are mistaken for someone else.\n\nTable: Weather\n3: Clear skies and a light breeze\n2: Overcast and cool\n2: Light drizzle, roads getting muddy\nHeavy rain, visibility poor\nThick fog until midday\nStrong winds, hard to hear each other\nA thunderstorm rolls in by evening\nUnusually hot and humid\nFrost in the morning, cold all day\nSnow flurries\n",
};
const STARTER_TABLES = [
  ["Loot", "Pocket loot · CR 0–4", "LootIndividualCR0to4", "loot"],
  ["Loot", "Pocket loot · CR 5–10", "LootIndividualCR5to10", "loot"],
  ["Loot", "Pocket loot · CR 11–16", "LootIndividualCR11to16", "loot"],
  ["Loot", "Pocket loot · CR 17+", "LootIndividualCR17plus", "loot"],
  ["Loot", "Hoard · CR 0–4", "LootHoardCR0to4", "loot"],
  ["Loot", "Hoard · CR 5–10", "LootHoardCR5to10", "loot"],
  ["Loot", "Hoard · CR 11–16", "LootHoardCR11to16", "loot"],
  ["Loot", "Hoard · CR 17+", "LootHoardCR17plus", "loot"],
  ["Magic items", "Common", "MagicCommon", "loot"],
  ["Magic items", "Uncommon", "MagicUncommon", "loot"],
  ["Magic items", "Rare", "MagicRare", "loot"],
  ["Magic items", "Very rare", "MagicVeryRare", "loot"],
  ["Magic items", "Legendary", "MagicLegendary", "loot"],
  ["Valuables", "Gem", "GemAny", "loot"],
  ["Valuables", "Art object", "ArtAny", "loot"],
  ["Valuables", "Trinket", "Trinket", "loot"],
  ["Valuables", "What's in their pockets?", "PocketJunk", "loot"],
  ["At the table", "Tavern name", "TavernName", "everyday"],
  ["At the table", "NPC quirk", "NPCQuirk", "everyday"],
  ["At the table", "Rumour", "Rumour", "everyday"],
  ["At the table", "Complication", "Complication", "everyday"],
  ["At the table", "Weather", "Weather", "everyday"],
].map(([group, label, name, file]) => ({ id: `st-${name}`, group, label, name, starter: file === "loot" ? "GM Screen Loot.rdm" : "GM Screen Everyday.rdm" }));

const COINS = ["pp", "gp", "ep", "sp", "cp"];
/** HTML/markdown result → plain text. */
/** "dungeonOrigin" → "Dungeon origin", "LootHoardCR0to4" → "Loot hoard CR0to4". */
function humanizeTable(name) {
  const s = String(name || "").replace(/^__note:[^^]*\^/, "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1).replace(/ ([A-Z])(?=[a-z])/g, (m, c) => ` ${c.toLowerCase()}`) : s;
}
/**
 * Randomness tables defined inside a note:
 *  - a markdown lookup table followed by a "^blockId" line (named after the heading above it);
 *  - "Table: Name" in a ```randomness codeblock (with that block's "Prompt:" lines).
 */
function noteTablesIn(md) {
  const out = [];
  const lines = String(md || "").split("\n");
  let heading = "";
  let inBlock = false;
  let fence = "";
  let prompts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (inBlock) {
      if (line.trim().startsWith(fence) && !line.trim().replace(/[`~]/g, "")) { inBlock = false; continue; }
      const pm = /^\s*Prompt:\s*(.+?)\s*\{([^}]*)\}\s*(.*)$/i.exec(line);
      if (pm) { prompts.push({ label: pm[1].trim(), options: pm[2].split("|").map((x) => x.trim()).filter(Boolean), def: pm[3].trim() }); continue; }
      const tm = /^\s*Table:\s*(.+?)\s*$/i.exec(line);
      if (tm) out.push({ name: tm[1], label: humanizeTable(tm[1]), heading, kind: "block", prompts: prompts.map((x) => ({ ...x })), calls: [] });
      else if (out.length && out[out.length - 1].kind === "block") for (const c of line.matchAll(/\[@([A-Za-z_][\w-]*)/g)) out[out.length - 1].calls.push(c[1]);
      continue;
    }
    const fm = /^\s*(`{3,}|~{3,})\s*randomness\b/.exec(line);
    if (fm) { inBlock = true; fence = fm[1]; prompts = []; continue; }
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) { heading = h[2].trim(); continue; }
    const b = /^\^([A-Za-z][\w-]*)\s*$/.exec(line.trim());
    if (b) {
      let j = i - 1;
      while (j >= 0 && !lines[j].trim()) j--;
      if (j >= 0 && /^\s*\|.*\|\s*$/.test(lines[j])) out.push({ name: b[1], label: heading || humanizeTable(b[1]), heading, kind: "table", prompts: [] });
    }
  }
  return out;
}
/** The ^id of the lookup table under a heading (for Atlas-style "[[Note#Heading|…]]" links). */
function tableIdUnderHeading(md, heading) {
  const want = String(heading || "").trim().toLowerCase();
  const lines = String(md || "").split("\n");
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[i]);
    if (level) {
      if (h && h[1].length <= level) return null;
      const b = /^\^([A-Za-z][\w-]*)\s*$/.exec(lines[i].trim());
      if (b) return b[1];
    } else if (h && h[2].trim().toLowerCase() === want) level = h[1].length;
  }
  return null;
}
/** Set a codeblock's prompts in front of a call: {! Prompt1 = "CR5to10"}[@Hoard] (the value echoes, so strip it after). */
function promptPrefix(values) {
  const vals = (values || []).map((v) => String(v).replace(/"/g, ""));
  return { expr: vals.map((v, i) => `{! Prompt${i + 1} = "${v}"}`).join(""), echo: vals.join("") };
}
function plainResult(text) {
  return String(text || "")
    .replace(/!?\[\[([^\]|]*?)(?:\|([^\]]+))?\]\]/g, (m, a, b) => b || String(a).split("#").pop().split("/").pop())
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\*\*|__/g, "");
}
/**
 * Split a loot result into coins and items. Pieces are separated by ";", new lines or bullets.
 * "120 gp" → coins; "Azurite (10 gp)" → item with a cost; "2x Potion of Healing" → qty 2.
 */
function parseLoot(text) {
  const coins = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  const items = [];
  // keep link targets: "[[+1 War Pick]]" → name, and remember the note it points to
  const raw = String(text || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li)>/gi, "\n");
  const rawPieces = raw
    .split(/[;\n•]+|(?<=\)|\]\])\s*,\s+/)
    .flatMap((x) => {
      // "11 gp and a trinket" → coins + item
      const m = /^\s*((?:\d[\d\s,.]*)\s*(?:[×x]\s*\d[\d\s,.]*\s*)?(?:pp|gp|ep|sp|cp))\s+(?:and|a|\+|&)\s+(.+)$/i.exec(plainResult(x));
      return m && !/\[\[/.test(m[1]) ? [m[1], x.replace(/^[^[]*?\s(?:and|a|\+|&)\s+/i, "")] : [x];
    });
  for (let rawPiece of rawPieces) {
    const lm = /\[\[([^\]|#]+)(?:\|[^\]]+)?\]\]/.exec(rawPiece);
    const link = lm ? lm[1].trim() : null;
    let piece = plainResult(rawPiece).trim().replace(/^[-*]\s+/, "").replace(/[.,]$/, "").trim();
    piece = piece.replace(/^[A-Za-zÀ-ž ]{2,30}:\s+(?=\S)/, ""); // "magic items: Ring of X"
    // Atlas-style "13 × 10 gp" → 130 gp
    piece = piece.replace(/(\d[\d,]*)\s*[×x]\s*(\d[\d,]*)\s*(pp|gp|ep|sp|cp)\b/gi, (m, a, b, c) => `${parseInt(a.replace(/,/g, ""), 10) * parseInt(b.replace(/,/g, ""), 10)} ${c}`);
    if (!piece) continue;
    if (/^(no\b|none$|nothing$|nic$|žádn)/i.test(piece)) continue;
    const coinOnly = /^(?:(?:\d[\d\s,.]*)\s*(?:pp|gp|ep|sp|cp)\b\s*(?:,|and|\+)?\s*)+$/i.test(piece);
    if (coinOnly) {
      for (const m of piece.matchAll(/(\d[\d\s,.]*)\s*(pp|gp|ep|sp|cp)\b/gi)) coins[m[2].toLowerCase()] += parseInt(m[1].replace(/[\s,.]/g, ""), 10) || 0;
      continue;
    }
    let name = piece;
    let qty = 1;
    let cost = "";
    let m = /^(\d+)\s*(?:x|×)\s+(.+)$/i.exec(name) || /^(\d+)\s+(?=[A-Z])(.+)$/.exec(name);
    if (m) { qty = parseInt(m[1], 10); name = m[2]; }
    m = /^(.+?)\s*\(\s*(?:x|×)\s*(\d+)\s*\)$/i.exec(name);
    if (m) { name = m[1]; qty = parseInt(m[2], 10); }
    m = /^(.+?)\s*\((\d[\d,]*)\s*(pp|gp|ep|sp|cp)\)$/i.exec(name);
    if (m) { name = m[1]; cost = `${m[2].replace(/,/g, "")} ${m[3].toUpperCase()}`; }
    name = name.trim();
    if (!name) continue;
    const same = items.find((x) => x.name.toLowerCase() === name.toLowerCase() && x.cost === cost);
    if (same) same.qty += qty;
    else items.push(link && !/^#/.test(link) ? { name, qty, cost, link } : { name, qty, cost });
  }
  return { coins, items, any: items.length > 0 || COINS.some((c) => coins[c]) };
}
const coinText = (c) => COINS.filter((k) => c[k]).map((k) => `${c[k].toLocaleString("en-US")} ${k}`).join(", ");
/** Split coins between n people; leftovers go to the first ones. */
function splitCoins(coins, n) {
  const out = Array.from({ length: n }, () => ({ pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 }));
  for (const k of COINS) {
    const total = coins[k] || 0;
    const each = Math.floor(total / n);
    let rest = total - each * n;
    for (const o of out) {
      o[k] = each + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
    }
  }
  return out;
}
const slugParty = (name) => String(name || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const itemKey = (name) => String(name || "").toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, " ").trim();
const invId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

/* ================= Soundboard ================= */

const AUDIO_EXT = ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "webm", "opus"];
const isAudio = (f) => f instanceof TFile && AUDIO_EXT.includes(String(f.extension || "").toLowerCase());
const PAD_COLORS = { gray: "#8a8f98", red: "#e5484d", orange: "#f76b15", yellow: "#e2a336", green: "#30a46c", teal: "#12a594", blue: "#0090ff", purple: "#8e4ec6", pink: "#d6409f" };
const PAD_KINDS = {
  music: { label: "Music", desc: "One at a time – starting another music button fades this one out.", icon: "music", color: "blue", loop: true },
  ambience: { label: "Ambience", desc: "Loops and plays alongside music and other ambience (rain, tavern, wind).", icon: "wind", color: "green", loop: true },
  effect: { label: "Sound effect", desc: "Plays once. Pressing it again starts it from the beginning.", icon: "zap", color: "orange", loop: false },
};
const PAD_ICONS = ["music", "drum", "guitar", "piano", "mic", "wind", "cloud-rain", "cloud-lightning", "snowflake", "flame", "waves", "trees", "mountain", "castle", "tent", "beer", "swords", "sword", "shield", "skull", "ghost", "bone", "bird", "dog", "footprints", "door-open", "bell", "sparkles", "wand", "crown", "heart", "moon", "sun", "zap", "volume-2"];
const padKind = (pad) => (PAD_KINDS[pad && pad.kind] ? pad.kind : "music");
const padLoops = (pad) => (pad && typeof pad.loop === "boolean" ? pad.loop : PAD_KINDS[padKind(pad)].loop);
function shuffled(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Plays soundboard buttons. Lives on the plugin, so sounds keep going while
 * tiles are re-drawn, screens switched or the GM screen tab is closed.
 */
class SoundBoard {
  constructor(plugin) {
    this.plugin = plugin;
    this.playing = new Map(); // pad id → { pad, queue, index, audio, stopping, errors }
    this.subs = new Set();
  }
  get app() { return this.plugin.app; }
  subscribe(fn) {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }
  emit(id) {
    for (const fn of [...this.subs]) {
      try { fn(id); } catch (e) { console.error(e); }
    }
  }
  master() { return Math.min(100, Math.max(0, Number(this.plugin.settings.sound.volume) || 0)) / 100; }
  fadeMs() { const v = Number(this.plugin.settings.sound.fade); return Number.isFinite(v) ? Math.max(0, v) : 1200; }
  vol(pad) {
    const v = pad.volume === undefined ? 80 : Number(pad.volume);
    return Math.min(1, Math.max(0, (Math.min(100, Math.max(0, v)) / 100) * this.master()));
  }
  /** Files (or web links) a button plays, in folder order. */
  tracks(pad) {
    const src = pad.src || {};
    if (src.type === "url") return src.path ? [src.path] : [];
    const f = this.app.vault.getAbstractFileByPath(src.path || "");
    if (isAudio(f)) return [f];
    if (f instanceof TFolder) {
      const out = [];
      const walk = (d) => {
        for (const c of d.children) {
          if (c instanceof TFolder) walk(c);
          else if (isAudio(c)) out.push(c);
        }
      };
      walk(f);
      return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
    }
    return [];
  }
  urlOf(t) { return typeof t === "string" ? t : this.app.vault.getResourcePath(t); }
  nameOf(t) {
    if (!t) return "";
    if (typeof t !== "string") return t.basename;
    try { return decodeURIComponent(t.split(/[?#]/)[0].split("/").pop() || t); } catch (e) { return t; }
  }
  state(id) {
    const p = this.playing.get(id);
    if (!p) return null;
    const a = p.audio;
    const d = a && Number.isFinite(a.duration) && a.duration > 0 ? a.duration : 0;
    return { track: this.nameOf(p.queue[p.index]), index: p.index, count: p.queue.length, progress: d ? Math.min(1, a.currentTime / d) : 0, stopping: p.stopping };
  }
  isPlaying(id) { const p = this.playing.get(id); return !!p && !p.stopping; }
  toggle(pad) {
    if (this.isPlaying(pad.id)) {
      if (padKind(pad) === "effect") return this.play(pad);
      return this.stop(pad.id);
    }
    return this.play(pad);
  }
  play(pad) {
    let queue = this.tracks(pad);
    if (!queue.length) {
      new Notice(`"${pad.label || "Sound"}" has no audio to play. Right-click it → Edit… to pick a file or folder.`);
      return;
    }
    if (pad.order === "shuffle") queue = shuffled(queue);
    const kind = padKind(pad);
    if (kind === "music") for (const [id, o] of this.playing) if (id !== pad.id && padKind(o.pad) === "music") this.stop(id);
    const old = this.playing.get(pad.id);
    if (old) this.kill(old);
    const p = { pad, queue, index: 0, audio: null, stopping: false, errors: 0 };
    this.playing.set(pad.id, p);
    this.start(p, kind !== "effect");
    this.emit(pad.id);
  }
  start(p, fadeIn) {
    const a = new Audio(this.urlOf(p.queue[p.index]));
    p.audio = a;
    const target = this.vol(p.pad);
    const fade = fadeIn && this.fadeMs() > 0;
    a.volume = fade ? 0 : target;
    a.loop = p.queue.length === 1 && padLoops(p.pad);
    a.addEventListener("timeupdate", () => this.emit(p.pad.id));
    a.addEventListener("ended", () => { if (p.audio === a) this.advance(p); });
    a.addEventListener("error", () => {
      if (p.audio !== a || this.playing.get(p.pad.id) !== p) return;
      new Notice(`Can't play ${this.nameOf(p.queue[p.index])}`);
      this.advance(p, true);
    });
    const pr = a.play();
    const ok = () => { if (fade && p.audio === a && !p.stopping) this.fade(a, target, this.fadeMs()); };
    if (pr && typeof pr.then === "function") pr.then(ok, (e) => { if (p.audio === a && e && e.name !== "AbortError") { console.warn("GM screen sound:", e); this.advance(p, true); } });
    else ok();
  }
  advance(p, failed) {
    if (this.playing.get(p.pad.id) !== p || p.stopping) return;
    if (failed && ++p.errors >= p.queue.length) return this.end(p);
    p.index++;
    if (p.index >= p.queue.length) {
      if (!padLoops(p.pad)) return this.end(p);
      p.index = 0;
      if (p.pad.order === "shuffle" && p.queue.length > 2) p.queue = shuffled(p.queue);
    }
    this.start(p, false);
    this.emit(p.pad.id);
  }
  /** Skip to the next track of a folder button. */
  next(id) {
    const p = this.playing.get(id);
    if (!p || p.stopping || p.queue.length < 2) return;
    this.kill(p);
    p.index = (p.index + 1) % p.queue.length;
    this.start(p, true);
    this.emit(id);
  }
  stop(id, now) {
    const p = this.playing.get(id);
    if (!p || p.stopping) return;
    p.stopping = true;
    this.emit(id);
    const a = p.audio;
    if (now || !a || this.fadeMs() <= 0 || a.paused) return this.end(p);
    this.fade(a, 0, this.fadeMs(), () => this.end(p));
  }
  stopAll(now) { for (const id of [...this.playing.keys()]) this.stop(id, now); }
  end(p) {
    this.kill(p);
    if (this.playing.get(p.pad.id) === p) this.playing.delete(p.pad.id);
    this.emit(p.pad.id);
  }
  kill(p) {
    const a = p.audio;
    if (!a) return;
    if (a._gmsFade) window.clearInterval(a._gmsFade);
    a._gmsFade = 0;
    try { a.pause(); } catch (e) { /* already gone */ }
  }
  fade(a, to, ms, done) {
    if (a._gmsFade) window.clearInterval(a._gmsFade);
    const from = a.volume;
    const steps = Math.max(1, Math.round(ms / 50));
    let i = 0;
    a._gmsFade = window.setInterval(() => {
      i++;
      a.volume = Math.min(1, Math.max(0, from + ((to - from) * i) / steps));
      if (i >= steps) {
        window.clearInterval(a._gmsFade);
        a._gmsFade = 0;
        if (done) done();
      }
    }, 50);
  }
  /** Volume slider moved / a button's volume edited. */
  refreshVolumes() {
    for (const p of this.playing.values()) if (p.audio && !p.audio._gmsFade && !p.stopping) p.audio.volume = this.vol(p.pad);
  }
  /** Button settings changed while it plays (kind, loop, volume). */
  updated(pad) {
    const p = this.playing.get(pad.id);
    if (!p) return;
    if (p.audio) p.audio.loop = p.queue.length === 1 && padLoops(pad);
    this.refreshVolumes();
    this.emit(pad.id);
  }
}

class AudioPicker extends FuzzySuggestModal {
  constructor(plugin, onPick) {
    super(plugin.app);
    this.onPick = onPick;
    this.setPlaceholder("Pick a track or a folder of tracks");
  }
  getItems() {
    const files = this.app.vault.getFiles().filter(isAudio);
    const folders = new Map();
    for (const f of files) {
      for (let d = f.parent; d && d.path && d.path !== "/"; d = d.parent) folders.set(d.path, (folders.get(d.path) || 0) + 1);
    }
    const out = [...folders].map(([path, count]) => ({ type: "folder", path, count }));
    for (const f of files) out.push({ type: "file", path: f.path });
    return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  }
  getItemText(it) { return it.type === "folder" ? `📁 ${it.path}  (${it.count} tracks)` : `♪ ${it.path}`; }
  onChooseItem(it) { this.onPick(it); }
  onOpen() {
    super.onOpen();
    if (!this.app.vault.getFiles().some(isAudio)) new Notice(`No audio files in the vault yet (${AUDIO_EXT.join(", ")}). Put some in a folder, e.g. "Sounds/Tavern".`);
  }
}

class SoundPadModal extends Modal {
  constructor(plugin, pad, onSave, onDelete) {
    super(plugin.app);
    this.plugin = plugin;
    this.isNew = !pad;
    this.pad = pad ? clone(pad) : { id: uid(), label: "", kind: "music", src: null, order: "order", volume: 80 };
    this.onSave = onSave;
    this.onDelete = onDelete;
  }
  onOpen() {
    this.titleEl.setText(this.isNew ? "New sound button" : `Edit "${this.pad.label || "Sound"}"`);
    this.draw();
  }
  draw() {
    const el = this.contentEl;
    const p = this.pad;
    el.empty();
    el.addClass("gms-pad-modal");
    const kind = padKind(p);

    const srcText = () => {
      if (!p.src || !p.src.path) return "Nothing picked yet.";
      if (p.src.type === "url") return `Web link: ${p.src.path}`;
      if (p.src.type === "folder") return `Folder: ${p.src.path} (${this.plugin.sound.tracks(p).length} tracks)`;
      return `Track: ${p.src.path}`;
    };
    const srcSet = new Setting(el).setName("Sound").setDesc(srcText());
    srcSet.addButton((b) => b.setButtonText("Pick track or folder…").setCta().onClick(() => new AudioPicker(this.plugin, (it) => {
      p.src = { type: it.type, path: it.path };
      if (!p.label) p.label = it.path.split("/").pop().replace(/\.[^.]+$/, "");
      if (this.isNew && !p.kindTouched) p.kind = it.type === "folder" ? "music" : "effect";
      this.draw();
    }).open()));
    new Setting(el)
      .setName("…or a web link")
      .setDesc("A direct link to an audio file (https://…/rain.mp3). Streaming sites like YouTube or Spotify won't work.")
      .addText((t) => t.setPlaceholder("https://").setValue(p.src && p.src.type === "url" ? p.src.path : "").onChange((v) => {
        v = v.trim();
        if (v) p.src = { type: "url", path: v };
        else if (p.src && p.src.type === "url") p.src = null;
      }));
    new Setting(el).setName("Name").addText((t) => t.setValue(p.label || "").setPlaceholder("Tavern, Battle, Thunder…").onChange((v) => (p.label = v)));
    new Setting(el)
      .setName("Type")
      .setDesc(PAD_KINDS[kind].desc)
      .addDropdown((d) => {
        for (const [k, v] of Object.entries(PAD_KINDS)) d.addOption(k, v.label);
        d.setValue(kind).onChange((v) => {
          p.kind = v;
          p.kindTouched = true;
          delete p.loop;
          this.draw();
        });
      });
    if (!p.src || p.src.type === "folder") {
      new Setting(el)
        .setName("Order")
        .setDesc("For a folder: play the tracks as they're sorted, or shuffled.")
        .addDropdown((d) => d.addOption("order", "In order").addOption("shuffle", "Shuffle").setValue(p.order === "shuffle" ? "shuffle" : "order").onChange((v) => (p.order = v)));
    }
    new Setting(el)
      .setName("Repeat")
      .setDesc("Start again when the last track ends.")
      .addToggle((t) => t.setValue(padLoops(p)).onChange((v) => (p.loop = v)));
    new Setting(el)
      .setName("Volume")
      .addSlider((s) => s.setLimits(0, 100, 5).setValue(p.volume === undefined ? 80 : p.volume).setDynamicTooltip().onChange((v) => (p.volume = v)));

    const colors = new Setting(el).setName("Colour").setClass("gms-pad-wrap").settingEl;
    const sw = colors.createDiv({ cls: "gms-pad-swatches" });
    const cur = p.color || PAD_KINDS[kind].color;
    for (const [k, hex] of Object.entries(PAD_COLORS)) {
      const b = sw.createEl("button", { cls: "gms-pad-swatch", attr: { "aria-label": k } });
      b.style.setProperty("--gms-pad", hex);
      b.toggleClass("is-on", k === cur);
      b.onclick = () => { p.color = k; this.draw(); };
    }
    const icons = new Setting(el).setName("Icon").setClass("gms-pad-wrap").settingEl;
    const ig = icons.createDiv({ cls: "gms-pad-icons" });
    const curIcon = p.icon || PAD_KINDS[kind].icon;
    for (const name of PAD_ICONS) {
      const b = ig.createEl("button", { cls: "gms-pad-iconbtn", attr: { "aria-label": name } });
      setIcon(b, name);
      b.toggleClass("is-on", name === curIcon);
      b.onclick = () => { p.icon = name; this.draw(); };
    }

    const row = el.createDiv({ cls: "modal-button-container" });
    if (!this.isNew && this.onDelete) {
      const del = row.createEl("button", { text: "Remove button", cls: "mod-warning" });
      del.onclick = () => { this.close(); this.onDelete(); };
    }
    row.createEl("button", { text: this.isNew ? "Add" : "Save", cls: "mod-cta" }).onclick = () => {
      if (!p.src || !p.src.path) return new Notice("Pick a track or folder first.");
      delete p.kindTouched;
      if (!p.label) p.label = this.plugin.sound.nameOf(p.src.type === "url" ? p.src.path : p.src.path.split("/").pop()).replace(/\.[^.]+$/, "");
      this.close();
      this.onSave(p);
    };
    row.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
  onClose() { this.contentEl.empty(); }
}

/**
 * Hand rolled loot out to one party (One DnD Character Sheet): pick the party, then who takes
 * each item, and where the coins go (split evenly between the ticked members, one member,
 * or the party's shared inventory).
 */
class LootHandoutModal extends Modal {
  constructor(plugin, text, onDone) {
    super(plugin.app);
    this.plugin = plugin;
    this.loot = parseLoot(text);
    this.onDone = onDone;
  }
  onOpen() {
    this.titleEl.setText("Hand out loot");
    this.contentEl.addClass("gms-handout");
    this.parties = this.plugin.lootParties();
    if (!this.parties.length) {
      this.contentEl.createDiv({ cls: "setting-item-description", text: "No party found. Create a party in One DnD Character Sheet (party groups), or pick your party in the GM screen settings." });
      return;
    }
    this.party = this.parties[this.plugin.defaultLootParty(this.parties)];
    this.resetPlan();
    this.draw();
  }
  /** Default plan for the chosen party: items to the party inventory (or the first member), coins split between everyone. */
  resetPlan() {
    const opts = this.recipients();
    const first = opts[0] ? opts[0].key : "";
    this.loot.items.forEach((it) => (it.to = first));
    this.coinMode = this.party.members.length > 1 ? "split" : first;
    this.splitWith = new Set(this.party.members.map((m) => m.path));
  }
  /** Who can receive things: the party inventory first (when there is one), then each member. */
  recipients() {
    const out = [];
    if (this.party.inventory) out.push({ key: this.party.inventory.path, label: `Party inventory (${this.party.name})`, target: this.party.inventory });
    for (const m of this.party.members) out.push({ key: m.path, label: m.name, target: m });
    return out;
  }
  draw() {
    const el = this.contentEl;
    el.empty();
    const opts = this.recipients();

    new Setting(el).setName("Party").setDesc(this.party.members.map((m) => m.name).join(", ") || "No members").addDropdown((d) => {
      this.parties.forEach((x, i) => d.addOption(String(i), x.name));
      d.setValue(String(this.parties.indexOf(this.party))).onChange((v) => {
        this.party = this.parties[Number(v)];
        this.resetPlan();
        this.draw();
      });
    });

    /* items */
    if (this.loot.items.length) {
      el.createDiv({ cls: "gms-handout-label", text: "Items – who takes what" });
      const list = el.createDiv({ cls: "gms-handout-items" });
      for (const it of this.loot.items) {
        const row = list.createDiv({ cls: "gms-handout-item" });
        const qty = row.createEl("input", { type: "number", cls: "gms-handout-qty", attr: { min: "1", step: "1", "aria-label": "Quantity" } });
        qty.value = String(it.qty);
        qty.addEventListener("input", () => (it.qty = Math.max(1, parseInt(qty.value, 10) || 1)));
        const nameBox = row.createDiv({ cls: "gms-handout-namebox" });
        const name = nameBox.createEl("input", { type: "text", cls: "gms-handout-name" });
        name.value = it.name;
        const meta = nameBox.createDiv({ cls: "gms-handout-meta" });
        const linked = meta.createSpan({ cls: "gms-handout-link" });
        const showLink = () => { const n = this.plugin.itemNote(it.name); linked.setText(n ? "linked" : ""); linked.setAttribute("aria-label", n ? `Linked to ${n.path}` : ""); };
        showLink();
        if (it.cost) meta.createSpan({ cls: "gms-handout-cost", text: it.cost });
        name.addEventListener("input", () => (it.name = name.value.trim()));
        name.addEventListener("change", showLink);
        const sel = row.createEl("select", { cls: "dropdown gms-handout-to", attr: { "aria-label": `Who takes ${it.name}` } });
        for (const o of opts) sel.createEl("option", { text: o.label, value: o.key });
        sel.createEl("option", { text: "— nobody (leave it)", value: "" });
        sel.value = it.to || "";
        sel.addEventListener("change", () => (it.to = sel.value));
      }
      if (opts.length > 1) {
        const all = el.createDiv({ cls: "gms-handout-all" });
        all.createSpan({ text: "Give every item to: " });
        for (const o of opts) {
          const b = all.createEl("button", { cls: "gms-handout-chip", text: o.label });
          b.onclick = () => { this.loot.items.forEach((x) => (x.to = o.key)); this.draw(); };
        }
      }
    }

    /* coins */
    const c = this.loot.coins;
    if (COINS.some((k) => c[k])) {
      el.createDiv({ cls: "gms-handout-label", text: "Coins" });
      const row = el.createDiv({ cls: "gms-handout-coins" });
      for (const k of COINS) {
        const box = row.createDiv({ cls: "gms-handout-coin" });
        const inp = box.createEl("input", { type: "number", attr: { min: "0", step: "1", "aria-label": k } });
        inp.value = String(c[k] || 0);
        inp.addEventListener("input", () => { c[k] = Math.max(0, parseInt(inp.value, 10) || 0); preview(); });
        box.createSpan({ text: k });
      }
      const how = el.createDiv({ cls: "gms-handout-coinmode" });
      how.createSpan({ text: "Go to: " });
      const sel = how.createEl("select", { cls: "dropdown" });
      if (this.party.members.length > 1) sel.createEl("option", { text: "Split evenly between…", value: "split" });
      for (const o of opts) sel.createEl("option", { text: o.label, value: o.key });
      sel.value = this.coinMode;
      sel.addEventListener("change", () => { this.coinMode = sel.value; this.draw(); });
      const who = el.createDiv({ cls: "gms-handout-split" });
      const prev = el.createDiv({ cls: "gms-handout-preview" });
      const preview = () => {
        prev.empty();
        if (this.coinMode !== "split") return;
        const members = this.party.members.filter((m) => this.splitWith.has(m.path));
        if (!members.length) return prev.setText("Tick at least one character.");
        const shares = splitCoins(c, members.length);
        prev.setText(members.map((m, i) => `${m.name}: ${coinText(shares[i]) || "–"}`).join(" · "));
      };
      if (this.coinMode === "split") {
        for (const m of this.party.members) {
          const lab = who.createEl("label", { cls: "gms-handout-member" });
          const cb = lab.createEl("input", { type: "checkbox" });
          cb.checked = this.splitWith.has(m.path);
          cb.addEventListener("change", () => { if (cb.checked) this.splitWith.add(m.path); else this.splitWith.delete(m.path); preview(); });
          lab.createSpan({ text: m.name });
        }
      }
      preview();
    }
    if (!this.loot.any) el.createDiv({ cls: "setting-item-description", text: "Nothing in this result looks like coins or items." });

    const btns = el.createDiv({ cls: "modal-button-container" });
    const give = btns.createEl("button", { text: "Give", cls: "mod-cta" });
    give.onclick = async () => {
      give.disabled = true;
      try {
        const plan = this.plan();
        if (!plan.length) { give.disabled = false; return new Notice("Nothing to give – pick who takes something."); }
        const done = await this.plugin.handOutLoot(plan);
        this.close();
        if (this.onDone) this.onDone(done);
      } catch (e) {
        console.error(e);
        new Notice(`Couldn't hand out the loot: ${e.message || e}`);
        give.disabled = false;
      }
    };
    btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
  }
  /** [{ target, items, coins }] – one entry per recipient. */
  plan() {
    const byKey = new Map();
    const opts = this.recipients();
    const slot = (key) => {
      const o = opts.find((x) => x.key === key);
      if (!o) return null;
      if (!byKey.has(key)) byKey.set(key, { target: o.target, items: [], coins: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 } });
      return byKey.get(key);
    };
    for (const it of this.loot.items) {
      if (!it.to || !it.name) continue;
      const sl = slot(it.to);
      if (sl) sl.items.push({ name: it.name, qty: it.qty, cost: it.cost, link: it.link });
    }
    const c = this.loot.coins;
    if (COINS.some((k) => c[k])) {
      if (this.coinMode === "split") {
        const members = this.party.members.filter((m) => this.splitWith.has(m.path));
        splitCoins(c, members.length || 1).forEach((share, i) => {
          if (!members[i]) return;
          const sl = slot(members[i].path);
          for (const k of COINS) sl.coins[k] += share[k];
        });
      } else {
        const sl = slot(this.coinMode);
        if (sl) for (const k of COINS) sl.coins[k] += c[k];
      }
    }
    return [...byKey.values()].filter((x) => x.items.length || COINS.some((k) => x.coins[k]));
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
    if (st.linked && st.fights && st.fights.length > 1) {
      const n = bar.createSpan({ cls: "gms-combat-linked", text: `${st.fights.length} initiatives`, attr: { "aria-label": st.fights.map((f) => (f.turn ? `▶ ${f.name}` : f.name)).join("\n") } });
      n.onclick = (e) => {
        const m = new Menu();
        for (const f of st.fights) m.addItem((it) => it.setTitle(f.turn ? `${f.name} (has the turn)` : f.name).setIcon(f.turn ? "play" : "swords").onClick(() => this.openPopup({ type: "combat", path: f.sourcePath, blockId: f.id || undefined, title: f.name || "Combat" })));
        m.showAtMouseEvent(e);
      };
    }
    bar.createSpan({ cls: "gms-combat-round", text: `Round ${st.round || 1}` });
    const other = (f) => !!(st.linked && f && f !== st.name);
    const turn = bar.createSpan({ cls: "gms-combat-turn" });
    turn.createSpan({ cls: "gms-combat-k", text: "Turn" });
    turn.createSpan({ cls: "gms-combat-v", text: st.current || "–" });
    if (st.next) {
      const nx = bar.createSpan({ cls: "gms-combat-next" });
      nx.createSpan({ cls: "gms-combat-k", text: "Next" });
      nx.createSpan({ cls: "gms-combat-v", text: st.next });
      if (other(st.nextFight)) nx.createSpan({ cls: "gms-combat-from", text: st.nextFight });
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
    this.sessionChip = el.createEl("button", { cls: "gms-session-chip gms-hidden" });
    this.sessionChip.onclick = (e) => this.sessionMenu(e);
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
  /** Toolbar chip: time left of the session, on every screen. */
  renderSessionChip() {
    const c = this.sessionChip;
    if (!c) return;
    const st = this.plugin.sessionState();
    c.toggleClass("gms-hidden", !st.started);
    if (!st.started) return;
    c.empty();
    setIcon(c.createSpan({ cls: "gms-session-chip-icon" }), st.running ? "hourglass" : "pause");
    c.createSpan({ text: st.over ? `+${hm(-st.left)} over` : `${hm(st.left)} left` });
    c.toggleClass("is-warn", st.warn && !st.over);
    c.toggleClass("is-over", st.over);
    c.toggleClass("is-paused", !st.running);
    c.setAttribute("aria-label", `Session timer – ${st.running ? "running" : "paused"}. Click for options.`);
  }
  sessionMenu(e) {
    const p = this.plugin;
    const st = p.sessionState();
    const m = new Menu();
    m.addItem((it) => it.setTitle(st.running ? "Pause session timer" : st.started ? "Resume session timer" : "Start session timer").setIcon(st.running ? "pause" : "play").onClick(() => p.sessionToggle()));
    m.addItem((it) => it.setTitle("Add 15 minutes").setIcon("plus").onClick(() => p.sessionAdjust(15)));
    m.addItem((it) => it.setTitle(`Session length (${durationText(p.settings.session.minutes)})…`).setIcon("timer").onClick(() => p.sessionLengthPrompt()));
    m.addItem((it) => it.setTitle(`Remind me ${p.settings.session.warn} min before the end…`).setIcon("bell").onClick(() => p.sessionWarnPrompt()));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Reset session timer").setIcon("rotate-ccw").onClick(() => p.sessionReset()));
    m.showAtMouseEvent(e);
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
    m.addItem((it) => it.setTitle("Note…").setIcon("file-text").onClick(() => new ListPicker(this.app, this.app.vault.getMarkdownFiles().slice().sort((a, b) => b.stat.mtime - a.stat.mtime), (f) => f.path.replace(/\.md$/, ""), (f) => this.plugin.addNoteWithPicker(f), "Pick a note").open()));
    m.addItem((it) => it.setTitle("Map…").setIcon("map").onClick(() => this.plugin.pickMapImage()));
    m.addItem((it) => it.setTitle("Sticky note").setIcon(TILE_ICONS.sticky).onClick(() => this.plugin.addTile({ type: "sticky" })));
    m.addItem((it) => it.setTitle("Checklist").setIcon(TILE_ICONS.checklist).onClick(() => this.plugin.addTile({ type: "checklist", items: [] })));
    m.addItem((it) => it.setTitle("Soundboard").setIcon(TILE_ICONS.sound).onClick(() => this.plugin.addTile({ type: "sound", pads: [] })));
    m.addItem((it) => it.setTitle("Clocks & timers").setIcon(TILE_ICONS.clocks).onClick(() => this.plugin.addTile({ type: "clocks", clocks: "" })));
    m.addItem((it) => it.setTitle("Random tables").setIcon("table-2").onClick(() => this.plugin.addTile({ type: "tables", tables: this.plugin.starterInstalled() ? clone(STARTER_TABLES) : [], history: [] })));
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
      this.iconBtn(acts, "plus", "Add to screen: the whole note or a part of it", () => this.plugin.addNoteWithPicker(r.file));
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
    if (spec.type === "map" && spec.image) {
      const img = this.app.vault.getAbstractFileByPath(spec.image);
      if (!(img instanceof TFile)) return { error: `Image not found: ${spec.image}` };
      const markers = this.plugin.markersFor(img.path, spec.markers);
      // sourcePath must NOT be the image: TTRPG Tools - Maps rewrites its "source note" for some
      // actions (save view to YAML), which would corrupt a binary file. A path that doesn't exist
      // makes those actions say "Source note not found"; markers still save to the markers.json.
      if (markers && this.plugin.zoomMap()) return { file: img, sourcePath: `${img.path}.gm-screen-map`, md: imageMapMarkdown(`gms-${spec.id || img.path}`, img.path, markers.path), mapBase: null };
      return { file: img, picture: true };
    }
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
    if (spec.type === "part") {
      const md = notePartMarkdown(text, { kind: spec.partKind, ref: spec.ref, index: spec.index });
      if (md === null) return { file, error: `This ${spec.partKind === "block" ? `block ^${spec.ref}` : spec.partKind} is no longer in ${file.basename}.` };
      return { file, md, mapBase: null };
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

  /** A plain image as a map: wheel to zoom (around the pointer), drag to pan, double-click to fit. */
  renderPicture(host, file, comp) {
    const wrap = host.createDiv({ cls: "gms-render is-map-render gms-picture", attr: { "data-gms-path": file.path } });
    const img = wrap.createEl("img", { attr: { src: this.app.vault.getResourcePath(file), alt: file.basename, draggable: "false" } });
    let s = 1;
    let x = 0;
    let y = 0;
    const apply = () => { img.style.transform = `translate(${x}px, ${y}px) scale(${s})`; };
    const fit = () => {
      const W = wrap.clientWidth;
      const H = wrap.clientHeight;
      const iw = img.naturalWidth || 1;
      const ih = img.naturalHeight || 1;
      if (!W || !H) return;
      s = Math.min(W / iw, H / ih);
      x = (W - iw * s) / 2;
      y = (H - ih * s) / 2;
      apply();
    };
    img.addEventListener("load", fit);
    if (img.complete) window.setTimeout(fit, 0);
    if (typeof ResizeObserver !== "undefined") {
      let last = "";
      const ro = new ResizeObserver(() => {
        const k = `${wrap.clientWidth}x${wrap.clientHeight}`;
        if (k !== last && !wrap.hasClass("is-moved")) fit();
        last = k;
      });
      ro.observe(wrap);
      if (comp) comp.register(() => ro.disconnect());
    }
    wrap.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = wrap.getBoundingClientRect();
      const px = e.clientX - r.left;
      const py = e.clientY - r.top;
      const ns = Math.min(20, Math.max(0.05, s * Math.exp(-e.deltaY * 0.0015)));
      x = px - ((px - x) * ns) / s;
      y = py - ((py - y) * ns) / s;
      s = ns;
      wrap.addClass("is-moved");
      apply();
    }, { passive: false });
    wrap.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const sx = e.clientX - x;
      const sy = e.clientY - y;
      wrap.addClass("is-panning");
      const move = (ev) => { x = ev.clientX - sx; y = ev.clientY - sy; wrap.addClass("is-moved"); apply(); };
      const up = () => {
        wrap.removeClass("is-panning");
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
    wrap.addEventListener("dblclick", () => { wrap.removeClass("is-moved"); fit(); });
    return wrap;
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
    if (c.picture) {
      this.renderPicture(host, c.file, comp);
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
    await MarkdownRenderer.render(this.app, c.md, el, c.sourcePath || c.file.path, comp);
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
    return [spec.type, spec.path, spec.heading || "", spec.mapId || spec.mapLine || spec.mapIndex || "", spec.blockId || "", spec.partKind || "", spec.ref || "", spec.image || ""].join("|");
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
    this.renderSessionChip();
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
    if (t.type === "sound") return t.title || "Soundboard";
    if (t.type === "tables") return t.title || "Random tables";
    if (t.type === "clocks") return t.title || (t.path ? `Clocks – ${t.path.split("/").pop().replace(/\.md$/, "")}` : "Clocks & timers");
    if (t.type === "sticky") {
      const first = String(t.text || "").split("\n").map((x) => x.trim()).find(Boolean);
      return first ? first.slice(0, 40) : "Sticky note";
    }
    if (t.type === "diary") return "Session notes";
    const base = (t.path || "").split("/").pop().replace(/\.md$/, "");
    if (t.type === "section") return `${base} › ${t.heading}`;
    if (t.type === "part") return `${base} › ${t.partKind === "block" ? `^${t.ref}` : t.ref || t.partKind}`;
    if (t.type === "map" && t.image) return t.image.split("/").pop().replace(/\.[^.]+$/, "");
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
    if (t.type === "clocks" && open) {
      const ib = this.iconBtn(head, "info", "How to write clocks, counters and timers", () => {
        const help = el.querySelector(".gms-ck-help");
        if (help) help.toggleClass("gms-hidden", !help.hasClass("gms-hidden"));
        ib.toggleClass("is-on", !!help && !help.hasClass("gms-hidden"));
      });
      ib.addClass("gms-ck-info");
    }
    if (t.type === "party" && open) {
      this.iconBtn(head, "user-plus", "Add character", () => this.plugin.pickCharacter(t));
      this.iconBtn(head, "refresh-cw", "Refresh", () => this.renderPartyTiles());
    }
    this.iconBtn(head, open ? "minimize-2" : "maximize-2", open ? "Shrink to name" : "Show content", () => this.toggleTile(t));
    this.iconBtn(head, "more-horizontal", "Tile options", (e) => this.tileMenu(t, e));

    const clickable = !open && (t.type === "note" || t.type === "section" || t.type === "part" || t.type === "map" || t.type === "combat");
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
    else if (t.type === "sound") this.renderSound(body, t);
    else if (t.type === "clocks") this.renderClocks(body, t);
    else if (t.type === "tables") this.renderTables(body, t);
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
    const content = t.type === "note" || t.type === "section" || t.type === "part" || t.type === "map" || t.type === "combat";
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
    if (t.type === "tables") {
      m.addItem((it) => it.setTitle("Add table…").setIcon("plus").onClick(() => this.plugin.pickRandomTable(t)));
      m.addItem((it) => it.setTitle("Clear results").setIcon("eraser").onClick(() => this.plugin.updateTile(t, { history: [] }, true)));
      m.addItem((it) => it.setTitle("Open Randomness browser").setIcon("dices").onClick(() => this.app.commands && this.app.commands.executeCommandById("randomness:open-generator-browser")));
      m.addSeparator();
    }
    if (t.type === "clocks") {
      m.addItem((it) => it.setTitle("Edit clocks as text…").setIcon("pencil").onClick(async () => {
        const src = this.clockSource(t);
        const text = await src.read();
        if (text === null) return;
        new TextAreaPrompt(this.app, "Clocks", text, (v) => src.change(() => v), "One per line, like in the Tabletop Clocks plugin: \"Alarm 2/6 red\", \"Torches: 6 of 10\", \"Ritual: 0:00 of 10:00\", \"Escape 0/6 vs Guards 0/6\", \"# Heading\".").open();
      }));
      m.addItem((it) => it.setTitle("Use clocks from a note…").setIcon("file-clock").onClick(() => this.plugin.pickClockNote(t)));
      if (t.path) {
        m.addItem((it) => it.setTitle("Open the note").setIcon("file-symlink").onClick(() => {
          const f = this.app.vault.getAbstractFileByPath(t.path);
          if (f instanceof TFile) this.openFile(f, false);
        }));
        m.addItem((it) => it.setTitle("Keep clocks on the screen instead").setIcon("unlink").onClick(async () => {
          const text = await this.clockSource(t).read();
          this.plugin.updateTile(t, { path: undefined, clockBlock: undefined, clocks: text || "" }, true);
        }));
      }
      m.addSeparator();
      m.addItem((it) => it.setTitle(t.showSession === false ? "Show session timer" : "Hide session timer").setIcon("hourglass").onClick(() => this.plugin.updateTile(t, { showSession: t.showSession === false }, true)));
      if (this.plugin.worldTime()) m.addItem((it) => it.setTitle(t.showWorld === false ? "Show in-game time" : "Hide in-game time").setIcon("calendar-clock").onClick(() => this.plugin.updateTile(t, { showWorld: t.showWorld === false }, true)));
      m.addSeparator();
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
    const list = Array.isArray(f.value) ? f.value : f.value ? String(f.value).split(/,\s*/) : [];
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

  /* ---------------- Random tables ---------------- */

  renderTables(body, t) {
    body.addClass("gms-tables");
    const p = this.plugin;
    if (!Array.isArray(t.tables)) t.tables = [];
    if (!Array.isArray(t.history)) t.history = [];
    const api = p.randomness();
    if (!api) {
      const e = body.createDiv({ cls: "gms-rt-empty" });
      e.createDiv({ text: "This tile rolls tables from the Randomness plugin." });
      e.createDiv({ cls: "setting-item-description", text: "Turn on Randomness in Settings → Community plugins, then come back." });
      return;
    }
    t.tables.forEach((e) => p.fixTableEntry(e));
    const rcomp = this.addChild(new Component());
    this.tileComps.push(rcomp);
    const wrap = body.createDiv({ cls: "gms-rt-wrap" });
    const listEl = wrap.createDiv({ cls: "gms-rt-list" });
    const resEl = wrap.createDiv({ cls: "gms-rt-results" });

    const drawResults = () => {
      resEl.empty();
      if (!t.history.length) {
        resEl.createDiv({ cls: "gms-rt-hint", text: "Click a table to roll it. Results stay here." });
        return;
      }
      t.history.forEach((h, i) => {
        const card = resEl.createDiv({ cls: "gms-rt-result" });
        card.toggleClass("is-new", i === 0 && Date.now() - (h.at || 0) < 1500);
        const head = card.createDiv({ cls: "gms-rt-result-head" });
        head.createSpan({ cls: "gms-rt-result-label", text: h.label });
        head.createSpan({ cls: "gms-rt-result-time", text: h.at ? moment(h.at).format("HH:mm") : "" });
        const txt = card.createDiv({ cls: "gms-rt-result-text" });
        try {
          // markdown + HTML, so [[item links]] are clickable
          MarkdownRenderer.render(this.app, String(h.result || "").replace(/; /g, "<br>"), txt, h.notePath || h.filePath || "", rcomp);
        } catch (e) {
          txt.setText(plainResult(h.result));
        }
        if (h.given) card.createDiv({ cls: "gms-rt-given", text: `✓ ${h.given}` });
        const row = card.createDiv({ cls: "gms-rt-actions" });
        const again = row.createEl("button", { cls: "gms-rt-act", attr: { "aria-label": "Roll this table again" } });
        setIcon(again, "refresh-cw");
        again.onclick = (ev) => {
          const e = t.tables.find((x) => x.id === h.tableId);
          if (e && e.prompts && e.prompts.length) return roll(e, null, { [e.prompts[0].label]: e.lastPrompt || e.prompts[0].def });
          roll(e || { name: h.name, label: h.label, filePath: h.filePath, notePath: h.notePath }, ev);
        };
        const copy = row.createEl("button", { cls: "gms-rt-act", attr: { "aria-label": "Copy" } });
        setIcon(copy, "copy");
        copy.onclick = async () => {
          try { await navigator.clipboard.writeText(plainResult(h.result).replace(/; /g, "\n")); new Notice("Copied."); } catch (e) { /* no clipboard */ }
        };
        if (p.isLootResult(h, t) && p.party.sheet) {
          const give = row.createEl("button", { cls: "gms-rt-act gms-rt-give" });
          setIcon(give.createSpan(), "hand-coins");
          give.createSpan({ text: "Hand out…" });
          give.onclick = () => new LootHandoutModal(p, h.result, (who) => {
            h.given = who;
            p.saveSoon();
            drawResults();
          }).open();
        }
        const del = row.createEl("button", { cls: "gms-rt-act gms-rt-del", attr: { "aria-label": "Remove from the list" } });
        setIcon(del, "x");
        del.onclick = () => { t.history.splice(i, 1); p.saveSoon(); drawResults(); };
      });
    };

    const roll = async (entry, ev, values) => {
      if (entry.prompts && entry.prompts.length && !values) {
        // ask the codeblock's prompt first (e.g. CR band) – remembered for next time
        const pr = entry.prompts[0];
        const m = new Menu();
        for (const opt of pr.options) {
          m.addItem((it) => it.setTitle(`${pr.label}: ${opt}`).setIcon(opt === (entry.lastPrompt || pr.def) ? "check" : "dices").onClick(() => {
            entry.lastPrompt = opt;
            p.saveSoon();
            roll(entry, null, { [pr.label]: opt });
          }));
        }
        if (ev && ev.clientX !== undefined) m.showAtMouseEvent(ev);
        else roll(entry, null, { [pr.label]: entry.lastPrompt || pr.def });
        return;
      }
      const r = await p.rollTable(entry, values);
      if (!r) return;
      t.history.unshift({ tableId: entry.id, name: entry.name, filePath: r.filePath, notePath: r.notePath || undefined, label: `${entry.label || entry.name}${r.prompt ? ` · ${r.prompt}` : ""}`, result: r.result, at: Date.now(), loot: p.isLootEntry(entry) });
      t.history.length = Math.min(t.history.length, 12);
      p.saveSoon();
      drawResults();
      resEl.scrollTop = 0;
    };

    // grouped table buttons
    const groups = new Map();
    for (const e of t.tables) {
      const g = e.group || "Tables";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(e);
    }
    for (const [g, entries] of groups) {
      const sec = listEl.createDiv({ cls: "gms-rt-group" });
      sec.createDiv({ cls: "gms-rt-group-name", text: g });
      const btns = sec.createDiv({ cls: "gms-rt-btns" });
      for (const e of entries) {
        const b = btns.createEl("button", { cls: "gms-rt-btn", text: e.label || e.name, attr: { "aria-label": `Roll ${e.name}` } });
        if (e.prompts && e.prompts.length) b.addClass("has-prompt");
        b.onclick = (ev) => roll(e, ev);
        b.addEventListener("contextmenu", (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          this.tableEntryMenu(t, e, ev);
        });
      }
    }
    const foot = listEl.createDiv({ cls: "gms-rt-foot" });
    const add = foot.createEl("button", { cls: "gms-rt-add" });
    setIcon(add.createSpan(), "plus");
    add.createSpan({ text: "Add table" });
    add.onclick = () => p.pickRandomTable(t);
    if (!p.starterInstalled()) {
      const st = foot.createEl("button", { cls: "gms-rt-add mod-cta" });
      setIcon(st.createSpan(), "package-plus");
      st.createSpan({ text: "Install starter tables" });
      st.setAttribute("aria-label", "Loot, hoards, magic items, gems, art, trinkets, tavern names, NPC quirks, rumours, complications, weather");
      st.onclick = async () => {
        if (await p.installStarterTables()) {
          const have = new Set(t.tables.map((x) => x.name));
          t.tables.push(...clone(STARTER_TABLES).filter((x) => !have.has(x.name)));
          p.updateTile(t, {}, true);
        }
      };
    } else if (!t.tables.some((x) => x.starter)) {
      const st = foot.createEl("button", { cls: "gms-rt-add" });
      setIcon(st.createSpan(), "list-plus");
      st.createSpan({ text: "Add the starter tables" });
      st.onclick = () => { t.tables.push(...clone(STARTER_TABLES)); p.updateTile(t, {}, true); };
    }
    drawResults();
  }

  tableEntryMenu(t, e, ev) {
    const m = new Menu();
    const i = t.tables.indexOf(e);
    m.addItem((it) => it.setTitle("Rename…").setIcon("pencil").onClick(() => new TextPrompt(this.app, "Button name", e.label || e.name, (v) => { e.label = v; this.plugin.updateTile(t, {}, true); }).open()));
    m.addItem((it) => it.setTitle("Group…").setIcon("folder").onClick(() => new TextPrompt(this.app, "Group (heading it's listed under)", e.group || "", (v) => { e.group = v; this.plugin.updateTile(t, {}, true); }).open()));
    if (i > 0) m.addItem((it) => it.setTitle("Move up").setIcon("arrow-up").onClick(() => { t.tables.splice(i - 1, 0, t.tables.splice(i, 1)[0]); this.plugin.updateTile(t, {}, true); }));
    if (i < t.tables.length - 1) m.addItem((it) => it.setTitle("Move down").setIcon("arrow-down").onClick(() => { t.tables.splice(i + 1, 0, t.tables.splice(i, 1)[0]); this.plugin.updateTile(t, {}, true); }));
    const loot = this.plugin.isLootEntry(e);
    m.addItem((it) => it.setTitle(loot ? "Results aren't loot (no Hand out…)" : "Results are loot (show Hand out…)").setIcon("hand-coins").onClick(() => { e.loot = !loot; this.plugin.updateTile(t, {}, true); }));
    const path = e.filePath || this.plugin.starterPath(e.starter);
    const f = path && this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) m.addItem((it) => it.setTitle("Open the table file").setIcon("file-symlink").onClick(() => this.app.workspace.getLeaf(true).openFile(f)));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Remove").setIcon("trash").onClick(() => { t.tables.splice(i, 1); this.plugin.updateTile(t, {}, true); }));
    m.showAtMouseEvent(ev);
  }

  /* ---------------- Clocks & timers ---------------- */

  renderClocks(body, t) {
    body.addClass("gms-clocks");
    const p = this.plugin;
    const comp = this.addChild(new Component());
    this.tileComps.push(comp);
    const help = body.createDiv({ cls: "gms-ck-help gms-hidden" });
    const scroll = body.createDiv({ cls: "gms-ck-scroll" });
    const ticks = []; // redraws every second

    /* --- session timer --- */
    if (t.showSession !== false) {
      const box = scroll.createDiv({ cls: "gms-ck-session" });
      const top = box.createDiv({ cls: "gms-ck-session-top" });
      top.createSpan({ cls: "gms-ck-label", text: "Session" });
      const len = top.createEl("button", { cls: "gms-ck-len", attr: { "aria-label": "Set the session length" } });
      len.onclick = () => p.sessionLengthPrompt();
      const big = box.createDiv({ cls: "gms-ck-session-time" });
      const sub = box.createDiv({ cls: "gms-ck-session-sub" });
      const bar = box.createDiv({ cls: "gms-ck-session-bar" }).createDiv();
      const row = box.createDiv({ cls: "gms-ck-session-row" });
      const go = row.createEl("button", { cls: "gms-ck-btn mod-cta" });
      go.onclick = () => p.sessionToggle();
      const plus = row.createEl("button", { cls: "gms-ck-btn", text: "+15 min", attr: { "aria-label": "Add 15 minutes to the session" } });
      plus.onclick = () => p.sessionAdjust(15);
      const reset = row.createEl("button", { cls: "gms-ck-btn gms-ck-icon", attr: { "aria-label": "Reset the session timer" } });
      setIcon(reset, "rotate-ccw");
      reset.onclick = () => p.sessionReset();
      const bell = row.createEl("button", { cls: "gms-ck-btn gms-ck-icon", attr: { "aria-label": "When to remind you before the end" } });
      setIcon(bell, "bell");
      bell.onclick = () => p.sessionWarnPrompt();
      const draw = () => {
        const st = p.sessionState();
        const ss = p.settings.session;
        len.setText(durationText(ss.minutes));
        big.setText(st.over ? `+${hms(-st.left)}` : hms(st.left));
        if (!st.started) sub.setText(`Reminder ${ss.warn} min before the end`);
        else if (st.over) sub.setText("Over time");
        else if (st.running) sub.setText(`Ends at ${moment(Date.now() + st.left).format("HH:mm")} · reminder ${ss.warn} min before`);
        else sub.setText(`Paused · ${hm(st.elapsed)} played`);
        bar.style.width = `${Math.min(100, (st.elapsed / Math.max(1, ss.minutes * 60000)) * 100)}%`;
        go.empty();
        setIcon(go.createSpan(), st.running ? "pause" : "play");
        go.createSpan({ text: st.running ? "Pause" : st.started ? "Resume" : "Start" });
        box.toggleClass("is-running", st.running);
        box.toggleClass("is-warn", st.warn && !st.over);
        box.toggleClass("is-over", st.over);
      };
      draw();
      ticks.push(draw);
    }

    /* --- in-game time (TTRPG Tools – Time) --- */
    if (t.showWorld !== false) {
      const box = scroll.createDiv({ cls: "gms-ck-world" });
      const draw = () => {
        const w = p.worldTime();
        box.toggleClass("gms-hidden", !w);
        if (!w) return;
        const key = `${w.date}|${w.time}`;
        if (box.dataset.key === key) return;
        box.dataset.key = key;
        box.empty();
        const head = box.createDiv({ cls: "gms-ck-world-head" });
        setIcon(head.createSpan({ cls: "gms-ck-world-icon" }), "calendar-clock");
        const when = head.createDiv({ cls: "gms-ck-world-when" });
        when.createDiv({ cls: "gms-ck-world-date", text: w.date });
        if (w.time) when.createDiv({ cls: "gms-ck-world-time", text: w.time });
        const open = head.createEl("button", { cls: "gms-ck-btn gms-ck-icon", attr: { "aria-label": "Open the calendar's control pane" } });
        setIcon(open, "external-link");
        open.onclick = () => this.app.commands && this.app.commands.executeCommandById("ttrpg-tools-time:open-control-pane");
        if (w.hasTime && w.buttons.length) {
          const row = box.createDiv({ cls: "gms-ck-world-btns" });
          for (const b of w.buttons) {
            const btn = row.createEl("button", { cls: "gms-ck-chip", text: b.label || `+${b.hours ? `${b.hours} h` : `${b.minutes} min`}` });
            btn.onclick = async () => {
              await w.tt.advanceFantasyClock(b.hours || 0, b.minutes || 0);
              draw();
            };
          }
        }
      };
      draw();
      let n = 0;
      ticks.push(() => { if (++n % 3 === 0) draw(); });
    }

    /* --- clocks, counters, stopwatches --- */
    const clocksEl = scroll.createDiv({ cls: "gms-ck-grid-wrap" });
    const src = this.clockSource(t);
    let clockTicks = [];
    ticks.push(() => clockTicks.forEach((f) => f()));
    const drawClocks = async () => {
      const text = await src.read();
      clockTicks = [];
      clocksEl.empty();
      if (text === null) {
        clocksEl.createDiv({ cls: "gms-ck-empty", text: `No clocks block found in ${t.path}. Use the tile menu to pick another note.` });
        return;
      }
      this.drawClockItems(clocksEl, t, src, text, clockTicks);
    };
    body._gmsRedraw = drawClocks;
    drawClocks();
    src.onChange(comp, drawClocks);

    const foot = body.createDiv({ cls: "gms-ck-foot" });
    const input = foot.createEl("input", { type: "text", cls: "gms-ck-add", attr: { placeholder: "Alarm 0/6 red · Torches: 6 · Ritual: 0:00 of 10:00", spellcheck: "false" } });
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    const addBtn = foot.createEl("button", { cls: "gms-ck-btn mod-cta", text: "Add" });
    const add = async () => {
      const v = input.value;
      if (!v.trim()) return;
      if (await src.change((x) => ckAdd(x, v, p.clockSize()))) input.value = "";
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); add(); }
    });
    addBtn.onclick = add;

    // Cheat sheet (ⓘ in the title bar). Click an example to put it in the add box.
    help.createDiv({ cls: "gms-ck-help-title", text: "Type one per line into the box at the bottom (or several separated by ;)" });
    const rows = [
      ["Alarm 0/6", "Progress clock with 6 segments (2–12). Click a segment or +/− to tick."],
      ["Alarm 0/6 red", "Add a colour: red, orange, yellow, green, cyan, blue, purple, pink."],
      ["Alarm", "No number → empty clock with the default size."],
      ["Escape 0/6 vs Guards 0/6", "Race: two clocks side by side, the first full one wins."],
      ["Torches: 6", "Counter you can raise or lower."],
      ["Torches: 6 of 10", "Counter with a maximum and a bar."],
      ["Ritual: 0:00", "Stopwatch – counts up while running."],
      ["Ritual: 0:00 of 10:00", "Countdown – shows time left, says when time's up."],
      ["# Heist", "Heading to group what follows."],
      ["[[Guards]] 0/4", "Link a note in the name."],
    ];
    const tbl = help.createDiv({ cls: "gms-ck-help-rows" });
    for (const [ex, desc] of rows) {
      const r = tbl.createDiv({ cls: "gms-ck-help-row" });
      const code = r.createEl("code", { cls: "gms-ck-help-ex", text: ex, attr: { "aria-label": "Put this in the add box" } });
      code.onclick = () => { input.value = input.value.trim() ? `${input.value.trim()}; ${ex}` : ex; input.focus(); };
      r.createDiv({ cls: "gms-ck-help-desc", text: desc });
    }
    help.createDiv({ cls: "gms-ck-help-foot", text: "× on a clock removes it. Tile menu (⋯) → Edit clocks as text… to change everything at once, or Use clocks from a note… to tick a clocks block that lives in a note." });

    comp.register(p.subscribeTick(() => ticks.forEach((f) => f())));
  }

  /** Where a clocks tile keeps its text: in the tile itself, or a ```clocks block in a note. */
  clockSource(t) {
    const p = this.plugin;
    if (!t.path) {
      return {
        key: (name) => `tile:${t.id}\n${name}`,
        read: async () => t.clocks || "",
        change: async (fn) => {
          t.clocks = fn(t.clocks || "");
          p.saveSoon();
          p.views().forEach((v) => v.refreshClockTiles(t));
          return true;
        },
        onChange: () => {},
      };
    }
    const n = t.clockBlock || 0;
    const file = () => this.app.vault.getAbstractFileByPath(t.path);
    return {
      key: (name) => `${t.path}\n${name}`,
      sourcePath: t.path,
      read: async () => {
        const f = file();
        if (!(f instanceof TFile)) return null;
        const b = findClockBlocks(await this.app.vault.read(f))[n];
        return b ? b.body : null;
      },
      change: async (fn) => {
        const f = file();
        if (!(f instanceof TFile)) return false;
        let ok = false;
        await this.app.vault.process(f, (md) => {
          const next = replaceClockBlock(md, n, fn);
          if (next === null) return md;
          ok = true;
          return next;
        });
        if (!ok) new Notice(`Couldn't find the clocks in ${t.path}.`);
        return ok;
      },
      onChange: (comp, redraw) => {
        comp.registerEvent(this.app.vault.on("modify", (f) => { if (f.path === t.path) redraw(); }));
      },
    };
  }

  refreshClockTiles(t) {
    for (const el of this.board ? this.board.querySelectorAll(".gms-tile-body.gms-clocks") : []) {
      if (el.dataset.tileId === t.id && el._gmsRedraw) el._gmsRedraw();
    }
  }

  drawClockItems(el, t, src, text, ticks) {
    const p = this.plugin;
    const def = p.clockSize();
    const items = parseClocks(text, def);
    let grid = null;
    const g = () => (grid = grid || el.createDiv({ cls: "gms-ck-grid" }));
    const notify = (name, extra) => {
      if (src.sourcePath) this.app.workspace.trigger(extra.event, { sourcePath: src.sourcePath, name, ...extra.data });
    };
    const menu = (e, index, label, part) => {
      e.preventDefault();
      e.stopPropagation();
      const m = new Menu();
      m.addItem((it) => it.setTitle(`Remove ${label}`).setIcon("trash").onClick(() => src.change((x) => ckRemovePart(x, index, part))));
      m.showAtMouseEvent(e);
    };
    const nameEl = (box, item) => {
      const n = box.createDiv({ cls: "gms-ck-name" });
      if (item.link) {
        const a = n.createEl("a", { cls: "internal-link", text: item.name });
        a.onclick = (e) => { e.preventDefault(); this.app.workspace.openLinkText(item.link, src.sourcePath || ""); };
      } else n.setText(item.name);
    };
    const color = (box, c) => { if (c) box.addClass(`gms-ck-${c}`); };
    const removeBtn = (box, index, part, name) => {
      const x = box.createEl("button", { cls: "gms-ck-del", attr: { "aria-label": `Remove ${name}` } });
      setIcon(x, "x");
      x.onclick = (e) => {
        e.stopPropagation();
        src.change((txt) => ckRemovePart(txt, index, part));
      };
    };

    const clock = (parent, index, c) => {
      const box = parent.createDiv({ cls: "gms-ck-item gms-ck-clock" });
      removeBtn(box, index, c.part, `"${c.name}"`);
      color(box, c.color);
      const full = c.filled >= c.size;
      box.toggleClass("is-full", full);
      const svg = box.createSvg("svg", { cls: "gms-ck-face", attr: { viewBox: "0 0 100 100", role: "slider", "aria-label": c.name, "aria-valuenow": c.filled, "aria-valuemax": c.size } });
      svg.createSvg("circle", { cls: "gms-ck-rim", attr: { cx: 50, cy: 50, r: 48 } });
      const gap = c.size > 8 ? 3 : 4;
      for (let k = 0; k < c.size; k++) {
        const a0 = -90 + (k * 360) / c.size + gap / 2;
        const a1 = -90 + ((k + 1) * 360) / c.size - gap / 2;
        const pt = (deg) => { const r = (deg * Math.PI) / 180; return `${(50 + 44 * Math.cos(r)).toFixed(2)} ${(50 + 44 * Math.sin(r)).toFixed(2)}`; };
        const seg = svg.createSvg("path", { cls: "gms-ck-seg", attr: { d: `M 50 50 L ${pt(a0)} A 44 44 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${pt(a1)} Z` } });
        if (k < c.filled) seg.classList.add("is-filled"); // one class per call – Obsidian's createSvg won't take "a b"
        seg.addEventListener("click", () => setFill(k + 1 === c.filled ? k : k + 1));
      }
      svg.createSvg("circle", { cls: "gms-ck-hub", attr: { cx: 50, cy: 50, r: 7 } });
      nameEl(box, c);
      const row = box.createDiv({ cls: "gms-ck-row" });
      const minus = row.createEl("button", { cls: "gms-ck-step", text: "−", attr: { "aria-label": `Clear a segment of ${c.name}` } });
      row.createSpan({ cls: "gms-ck-count", text: full ? "Full" : `${c.filled}/${c.size}` });
      const plusB = row.createEl("button", { cls: "gms-ck-step", text: "+", attr: { "aria-label": `Tick ${c.name}` } });
      const setFill = async (n) => {
        n = ckClamp(n, 0, c.size);
        if (n === c.filled && c.written) return;
        if (!(await src.change((x) => ckSetFill(x, index, c.part, n, def)))) return;
        notify(c.name, { event: "tabletop-clocks:change", data: { link: c.link, filled: n, previous: c.filled, size: c.size, full: n >= c.size } });
        if (n >= c.size && c.filled < c.size) new Notice(`${c.name} is full.`);
      };
      minus.onclick = () => setFill(c.filled - 1);
      plusB.onclick = () => setFill(c.filled + 1);
      box.addEventListener("contextmenu", (e) => menu(e, index, `"${c.name}"`, c.part));
      return box;
    };

    for (const it of items) {
      if (it.kind === "heading") {
        const h = el.createDiv({ cls: "gms-ck-heading" });
        setIcon(h.createSpan(), "clock");
        h.createSpan({ text: it.text });
        removeBtn(h, it.index, undefined, `heading "${it.text}"`);
        grid = null;
        continue;
      }
      if (it.kind === "clocks") {
        if (it.clocks.length === 2) {
          const race = g().createDiv({ cls: "gms-ck-race" });
          const a = clock(race, it.index, it.clocks[0]);
          race.createDiv({ cls: "gms-ck-vs", text: "vs" });
          const b = clock(race, it.index, it.clocks[1]);
          const fa = it.clocks[0].filled >= it.clocks[0].size;
          const fb = it.clocks[1].filled >= it.clocks[1].size;
          if (fa !== fb) (fa ? b : a).addClass("is-lost");
        } else clock(g(), it.index, it.clocks[0]);
        continue;
      }
      if (it.kind === "counter") {
        const c = it.counter;
        const box = g().createDiv({ cls: "gms-ck-item gms-ck-counter" });
        color(box, c.color);
        const val = box.createDiv({ cls: "gms-ck-value" });
        val.createSpan({ text: String(c.value) });
        if (c.max !== undefined) {
          val.createSpan({ cls: "gms-ck-of", text: ` / ${c.max}` });
          box.createDiv({ cls: "gms-ck-meter" }).createDiv().style.width = `${c.max ? (Math.max(0, c.value) / c.max) * 100 : 0}%`;
        }
        nameEl(box, c);
        const row = box.createDiv({ cls: "gms-ck-row" });
        const set = async (v) => {
          if (c.max !== undefined) v = ckClamp(v, 0, c.max);
          if (v === c.value) return;
          if (await src.change((x) => ckSetValue(x, it.index, v))) notify(c.name, { event: "tabletop-clocks:count", data: { link: c.link, value: v, previous: c.value, max: c.max } });
        };
        row.createEl("button", { cls: "gms-ck-step", text: "−", attr: { "aria-label": `One less ${c.name}` } }).onclick = () => set(c.value - 1);
        row.createEl("button", { cls: "gms-ck-step", text: "+", attr: { "aria-label": `One more ${c.name}` } }).onclick = () => set(c.value + 1);
        box.addEventListener("contextmenu", (e) => menu(e, it.index, `"${c.name}"`));
        removeBtn(box, it.index, undefined, `"${c.name}"`);
        continue;
      }
      if (it.kind === "stopwatch") {
        const w = it.stopwatch;
        const key = src.key(w.name);
        const box = g().createDiv({ cls: "gms-ck-item gms-ck-stopwatch" });
        color(box, w.color);
        const val = box.createDiv({ cls: "gms-ck-value gms-ck-time" });
        const meter = w.limit ? box.createDiv({ cls: "gms-ck-meter" }).createDiv() : null;
        nameEl(box, w);
        const row = box.createDiv({ cls: "gms-ck-row" });
        const go = row.createEl("button", { cls: "gms-ck-step" });
        const rs = row.createEl("button", { cls: "gms-ck-step", attr: { "aria-label": `Reset ${w.name}` } });
        setIcon(rs, "rotate-ccw");
        const started = () => p.clockRunning(key);
        const now = () => {
          const st = started();
          const sec = w.seconds + (st === undefined ? 0 : Math.max(0, Date.now() - st) / 1000);
          return w.limit !== undefined ? Math.min(sec, w.limit) : sec;
        };
        const save = async (sec, run) => {
          await p.setClockRunning(key, run ? Date.now() : null);
          const v = Math.floor(sec);
          if (v !== w.seconds) await src.change((x) => ckSetValue(x, it.index, v));
          else this.plugin.views().forEach((vw) => vw.refreshClockTiles(t));
          notify(w.name, { event: "tabletop-clocks:stopwatch", data: { link: w.link, seconds: v, running: run, limit: w.limit } });
        };
        const draw = () => {
          const sec = now();
          val.setText(w.limit !== undefined ? `${ckTime(w.limit - sec)}` : ckTime(sec));
          if (meter) meter.style.width = `${(sec / w.limit) * 100}%`;
          const full = w.limit !== undefined && sec >= w.limit;
          const run = started() !== undefined;
          box.toggleClass("is-full", full);
          box.toggleClass("is-running", run && !full);
          go.empty();
          setIcon(go, run && !full ? "pause" : "play");
          go.setAttribute("aria-label", `${run ? "Pause" : "Start"} ${w.name}`);
          if (full && run) p.clockTimeUp(key, w.name);
        };
        go.onclick = () => {
          if (started() !== undefined) save(now(), false);
          else if (w.limit === undefined || w.seconds < w.limit) save(w.seconds, true);
        };
        rs.onclick = () => save(0, false);
        box.addEventListener("contextmenu", (e) => menu(e, it.index, `"${w.name}"`));
        removeBtn(box, it.index, undefined, `"${w.name}"`);
        box.title = w.limit !== undefined ? `Counts down from ${ckTime(w.limit)}` : "Stopwatch";
        draw();
        ticks.push(draw);
      }
    }
    if (!items.some((x) => x.kind !== "heading")) {
      el.createDiv({ cls: "gms-ck-empty", text: "No clocks yet. Type one below, e.g. \"Alarm 0/6 red\", \"Torches: 6 of 10\", \"Ritual: 0:00 of 10:00\" (a countdown), or \"Escape 0/6 vs Guards 0/6\"." });
    }
  }

  /* ---------------- Soundboard ---------------- */

  renderSound(body, t) {
    body.addClass("gms-sound");
    if (!Array.isArray(t.pads)) t.pads = [];
    const sb = this.plugin.sound;
    const grid = body.createDiv({ cls: "gms-sb-grid" });
    const els = new Map();
    const paint = (id) => {
      for (const [pid, r] of els) {
        if (id && id !== pid) continue;
        const st = sb.state(pid);
        r.el.toggleClass("is-playing", !!st && !st.stopping);
        r.el.toggleClass("is-stopping", !!st && st.stopping);
        r.now.setText(st && (st.count > 1 || (r.pad.src && r.pad.src.type === "folder")) ? st.track : "");
        r.bar.style.width = `${Math.round((st ? st.progress : 0) * 1000) / 10}%`;
      }
    };
    t.pads.forEach((pad, i) => {
      const kind = padKind(pad);
      const el = grid.createEl("button", { cls: `gms-sb-pad gms-sb-${kind}`, attr: { "aria-label": `${pad.label || "Sound"} – ${PAD_KINDS[kind].label}. Click to play or stop, right-click for options.` } });
      el.style.setProperty("--gms-pad", PAD_COLORS[pad.color] || PAD_COLORS[PAD_KINDS[kind].color]);
      setIcon(el.createDiv({ cls: "gms-sb-icon" }), pad.icon || PAD_KINDS[kind].icon);
      el.createDiv({ cls: "gms-sb-label", text: pad.label || "Sound" });
      const now = el.createDiv({ cls: "gms-sb-now" });
      const badges = el.createDiv({ cls: "gms-sb-badges" });
      if (pad.src && pad.src.type === "folder" && pad.order === "shuffle") setIcon(badges.createSpan(), "shuffle");
      if (padLoops(pad)) setIcon(badges.createSpan(), "repeat");
      const bar = el.createDiv({ cls: "gms-sb-progress" }).createDiv();
      el.addEventListener("click", () => sb.toggle(pad));
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.padMenu(t, pad, i, e);
      });
      els.set(pad.id, { el, now, bar, pad });
    });
    const add = grid.createEl("button", { cls: "gms-sb-pad gms-sb-add", attr: { "aria-label": "Add a sound button (or drop an audio file / folder here)" } });
    setIcon(add.createDiv({ cls: "gms-sb-icon" }), "plus");
    add.createDiv({ cls: "gms-sb-label", text: "Add sound" });
    add.onclick = () => new SoundPadModal(this.plugin, null, (pad) => {
      t.pads.push(pad);
      this.plugin.updateTile(t, {}, true);
    }).open();

    const foot = body.createDiv({ cls: "gms-sb-foot" });
    setIcon(foot.createSpan({ cls: "gms-sb-vol-icon" }), "volume-2");
    const vol = foot.createEl("input", { type: "range", cls: "gms-sb-vol", attr: { min: "0", max: "100", step: "1", "aria-label": "Volume for all sounds" } });
    vol.value = String(this.plugin.settings.sound.volume);
    vol.addEventListener("pointerdown", (e) => e.stopPropagation());
    vol.addEventListener("input", () => {
      this.plugin.settings.sound.volume = Number(vol.value);
      sb.refreshVolumes();
      this.plugin.saveSoon();
    });
    const stop = foot.createEl("button", { cls: "gms-sb-stop", attr: { "aria-label": "Stop all sounds (fades out)" } });
    setIcon(stop.createSpan(), "square");
    stop.createSpan({ text: "Stop all" });
    stop.onclick = () => sb.stopAll();

    // Drop audio files / folders from the file explorer straight onto the board
    body.addEventListener("dragover", (e) => {
      const d = this.app.dragManager && this.app.dragManager.draggable;
      if (!d || !d.file) return;
      e.preventDefault();
      body.addClass("is-drop");
    });
    body.addEventListener("dragleave", () => body.removeClass("is-drop"));
    body.addEventListener("drop", (e) => {
      body.removeClass("is-drop");
      const d = this.app.dragManager && this.app.dragManager.draggable;
      const f = d && d.file;
      if (!f) return;
      e.preventDefault();
      const pad = this.plugin.padFromFile(f);
      if (!pad) return new Notice("Drop an audio file or a folder with audio files.");
      t.pads.push(pad);
      this.plugin.updateTile(t, {}, true);
    });

    paint();
    const comp = this.addChild(new Component());
    this.tileComps.push(comp);
    comp.register(sb.subscribe(paint));
  }

  padMenu(t, pad, i, e) {
    const sb = this.plugin.sound;
    const st = sb.state(pad.id);
    const m = new Menu();
    if (st && !st.stopping) {
      m.addItem((it) => it.setTitle("Stop").setIcon("square").onClick(() => sb.stop(pad.id)));
      if (st.count > 1) m.addItem((it) => it.setTitle("Next track").setIcon("skip-forward").onClick(() => sb.next(pad.id)));
      m.addSeparator();
    }
    m.addItem((it) => it.setTitle("Edit…").setIcon("pencil").onClick(() => new SoundPadModal(this.plugin, pad, (next) => {
      Object.keys(pad).forEach((k) => delete pad[k]);
      Object.assign(pad, next);
      sb.updated(pad);
      this.plugin.updateTile(t, {}, true);
    }, () => this.removePad(t, pad)).open()));
    if (i > 0) m.addItem((it) => it.setTitle("Move left").setIcon("arrow-left").onClick(() => {
      t.pads.splice(i - 1, 0, t.pads.splice(i, 1)[0]);
      this.plugin.updateTile(t, {}, true);
    }));
    if (i < t.pads.length - 1) m.addItem((it) => it.setTitle("Move right").setIcon("arrow-right").onClick(() => {
      t.pads.splice(i + 1, 0, t.pads.splice(i, 1)[0]);
      this.plugin.updateTile(t, {}, true);
    }));
    m.addItem((it) => it.setTitle("Duplicate").setIcon("copy").onClick(() => {
      t.pads.splice(i + 1, 0, { ...clone(pad), id: uid() });
      this.plugin.updateTile(t, {}, true);
    }));
    m.addSeparator();
    m.addItem((it) => it.setTitle("Remove").setIcon("trash").onClick(() => this.removePad(t, pad)));
    m.showAtMouseEvent(e);
  }

  removePad(t, pad) {
    this.plugin.sound.stop(pad.id, true);
    this.plugin.updateTile(t, { pads: t.pads.filter((x) => x !== pad) }, true);
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
    this.addCommand({ id: "sound-stop-all", name: "Soundboard: stop all sounds", callback: () => this.sound.stopAll() });
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
        if (!checking) this.addNoteWithPicker(f);
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
    this.sound = new SoundBoard(this);
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
      const ctx = rollContext(el, (x) => this.noteOfElement(x));
      this.spellRollKind(ctx);
      this.lastDiceClick = { t: Date.now(), label: guessRollLabel(el), ctx };
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
      if (isImage(file)) {
        menu.addItem((it) => it.setTitle("Add map to Game Master screen").setIcon("map").onClick(() => {
          const mk = this.markersFor(file.path);
          this.addTile({ type: "map", path: file.path, image: file.path, markers: mk ? mk.path : undefined, expanded: true });
        }));
        return;
      }
      if (!(file instanceof TFile) || file.extension !== "md") return;
      menu.addItem((it) => it.setTitle("Add to Game Master screen…").setIcon("shield").onClick(() => this.addNoteWithPicker(file)));
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
      for (const sc of this.settings.screens) for (const t of sc.tiles) {
        if (t.path === oldPath) { t.path = file.path; changed = true; }
        if (t.image === oldPath) { t.image = file.path; changed = true; }
        if (t.markers === oldPath) { t.markers = file.path; changed = true; }
      }
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
    this.registerInterval(window.setInterval(() => this.tick(), 1000));
    this.addCommand({ id: "session-toggle", name: "Session timer: start / pause", callback: () => this.sessionToggle() });
  }

  onunload() {
    const ri = this.ri();
    if (ri && this.rollerHook && typeof ri.setRoller === "function") ri.setRoller(null);
    if (this.cards) this.cards.destroy();
    if (this.sound) this.sound.stopAll(true);
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
    const seq = (this.combatSeq = (this.combatSeq || 0) + 1);
    this.linkedState(st).then((all) => {
      if (seq !== this.combatSeq) return; // a newer change came in meanwhile
      this.setCombatState(all || st || null);
    }, () => {
      if (seq === this.combatSeq) this.setCombatState(st || null);
    });
  }
  /** Roll for Initiative 1.8+: several initiatives running at once share one
   *  turn order. Their fights, read through its API, as one combined state;
   *  null when this fight isn't one of several. */
  async linkedState(st) {
    const p = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["roll-initiative"];
    const ri = this.ri();
    const L = p && p.settings && p.settings.linked;
    if (!ri || !st || !st.sourcePath || !L || !Array.isArray(L.fights) || L.fights.length < 2) return null;
    const mine = (r) => r && r.path === st.sourcePath && (r.id || "") === (st.id || "");
    if (!L.fights.some(mine)) return null;
    const states = await Promise.all(L.fights.map(async (r) => {
      if (mine(r)) return st;
      try { return await ri.getState(r.path, r.id || undefined); } catch (e) { return null; }
    }));
    return combineFights(states, L.turn, p.settings.skipDown !== false);
  }
  setCombatState(st) {
    this.combatState = st || null;
    this.views().forEach((v) => {
      v.renderCombatBar();
      v.renderPartySoon();
    });
  }
  /** The party card's place in the running fight, if any. */
  combatantFor(file, name) {
    const st = this.combatState;
    if (!st || !st.running || st.ended || !Array.isArray(st.combatants)) return null;
    const norm = (x) => String(x || "").replace(/\.md$/, "").split("/").pop().toLowerCase();
    const c = st.combatants.find((x) => (x.link && (x.link === file.path || norm(x.link) === norm(file.path))) || x.name === name || x.name === file.basename);
    if (!c) return null;
    return { ...c, isNext: !!st.next && c.name === st.next && (!st.nextPath || !c.fightPath || c.fightPath === st.nextPath) };
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
    s.sound = Object.assign(clone(DEFAULT_SETTINGS.sound), data.sound || {});
    s.session = Object.assign(clone(DEFAULT_SETTINGS.session), data.session || {});
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
  /* ----- one-second tick for timers ----- */
  subscribeTick(fn) {
    this.tickSubs = this.tickSubs || new Set();
    this.tickSubs.add(fn);
    return () => this.tickSubs.delete(fn);
  }
  tick() {
    this.sessionCheck();
    this.views().forEach((v) => v.renderSessionChip());
    for (const fn of [...(this.tickSubs || [])]) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  /* ----- session timer ----- */
  sessionState() {
    const ss = this.settings.session;
    const running = !!ss.startedAt;
    const elapsed = (Number(ss.elapsed) || 0) + (running ? Math.max(0, Date.now() - ss.startedAt) : 0);
    const left = (Number(ss.minutes) || 0) * 60000 - elapsed;
    return { running, started: running || elapsed > 0, elapsed, left, warn: left <= (Number(ss.warn) || 0) * 60000, over: left <= 0 };
  }
  sessionCheck() {
    const ss = this.settings.session;
    if (!ss.startedAt) return;
    const st = this.sessionState();
    if (!ss.warned && st.warn && !st.over && ss.warn > 0) {
      ss.warned = true;
      this.saveSoon();
      this.sessionAlert("warn", `${hm(st.left).replace(/^0:/, "")} minutes of the session left.`);
    }
    if (!ss.over && st.over) {
      ss.over = true;
      ss.warned = true;
      this.saveSoon();
      this.sessionAlert("over", "Session time is up.");
    }
  }
  sessionAlert(tone, text) {
    new Notice(`⏳ ${text}`, 15000);
    this.cards.showMessage({ title: "Session timer", text, tone });
    if (this.settings.session.chime !== false) this.chime(tone === "over" ? 3 : 2);
  }
  /** A soft two-tone chime (no audio file needed). */
  chime(times = 2) {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = this.chimeCtx || (this.chimeCtx = new Ctx());
      const t0 = ctx.currentTime + 0.02;
      for (let i = 0; i < times; i++) {
        for (const [f, d] of [[880, 0], [1320, 0.16]]) {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          o.type = "sine";
          o.frequency.value = f;
          const s = t0 + i * 0.6 + d;
          g.gain.setValueAtTime(0, s);
          g.gain.linearRampToValueAtTime(0.18 * this.sound.master(), s + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, s + 0.5);
          o.connect(g).connect(ctx.destination);
          o.start(s);
          o.stop(s + 0.55);
        }
      }
    } catch (e) { /* no audio */ }
  }
  sessionChanged() {
    this.saveSoon();
    this.tick();
  }
  sessionToggle() {
    const ss = this.settings.session;
    if (ss.startedAt) {
      ss.elapsed = (Number(ss.elapsed) || 0) + Math.max(0, Date.now() - ss.startedAt);
      ss.startedAt = null;
    } else {
      ss.startedAt = Date.now();
      const st = this.sessionState();
      ss.warned = st.warn; // starting with less than the reminder time left: no reminder
      ss.over = st.over;
    }
    this.sessionChanged();
  }
  sessionReset() {
    Object.assign(this.settings.session, { startedAt: null, elapsed: 0, warned: false, over: false });
    this.sessionChanged();
  }
  sessionAdjust(min) {
    const ss = this.settings.session;
    ss.minutes = Math.max(1, (Number(ss.minutes) || 0) + min);
    const st = this.sessionState();
    ss.warned = st.warn;
    ss.over = st.over;
    this.sessionChanged();
  }
  sessionLengthPrompt() {
    const ss = this.settings.session;
    new TextPrompt(this.app, "How long is the session? (e.g. 4 h, 3:30, 210 min)", durationText(ss.minutes).replace(" min", "m").replace(" h", "h"), (v) => {
      const m = parseDuration(v);
      if (!m) return new Notice("Couldn't read that. Try 4 h, 3:30 or 210 min.");
      ss.minutes = m;
      const st = this.sessionState();
      ss.warned = st.warn;
      ss.over = st.over;
      this.sessionChanged();
    }, "Set").open();
  }
  sessionWarnPrompt() {
    const ss = this.settings.session;
    new TextPrompt(this.app, "Remind me how many minutes before the end?", String(ss.warn), (v) => {
      const m = parseDuration(/^\d+$/.test(v.trim()) ? `${v}m` : v);
      if (m === null) return new Notice("Type a number of minutes, e.g. 30.");
      ss.warn = m;
      ss.warned = this.sessionState().warn;
      this.sessionChanged();
    }, "Set").open();
  }

  /* ----- TTRPG Tools – Time ----- */
  worldTime() {
    const tt = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["ttrpg-tools-time"];
    const cal = tt && tt.activeCalendar;
    if (!cal || !cal.definition || !cal.state) return null;
    const def = cal.definition;
    const d = cal.state.todayDate || {};
    const month = Array.isArray(def.months) ? def.months[d.monthIndex] : null;
    const mName = month ? month.name : `Month ${(d.monthIndex || 0) + 1}`;
    const date = month && month.days === 1 ? `${mName} ${d.year}` : `${d.day}. ${mName} ${d.year}`;
    let clock = null;
    try { clock = def.time && def.time.enabled && typeof tt.getFantasyClock === "function" ? tt.getFantasyClock(cal) : null; } catch (e) { clock = null; }
    const time = clock ? `${String(clock.hour).padStart(2, "0")}:${String(clock.minute).padStart(2, "0")}` : "";
    let buttons = [];
    try { buttons = typeof tt.getConfiguredTimeAdvanceButtons === "function" ? tt.getConfiguredTimeAdvanceButtons() : []; } catch (e) { buttons = []; }
    buttons = buttons.slice().sort((a, b) => ((a.hours || 0) * 60 + (a.minutes || 0)) - ((b.hours || 0) * 60 + (b.minutes || 0)));
    return { tt, cal, date, time, hasTime: !!clock && typeof tt.advanceFantasyClock === "function", buttons };
  }

  /* ----- clocks ----- */
  tabletopClocks() {
    return this.app.plugins && this.app.plugins.plugins ? this.app.plugins.plugins["tabletop-clocks"] : null;
  }
  clockSize() {
    const tc = this.tabletopClocks();
    const n = tc && tc.settings ? parseInt(tc.settings.size, 10) : NaN;
    return Number.isFinite(n) ? Math.max(2, Math.min(12, n)) : 4;
  }
  /** Running stopwatches: note clocks share Tabletop Clocks' own record, screen clocks keep theirs here. */
  clockRunning(key) {
    const tc = this.tabletopClocks();
    if (!key.startsWith("tile:") && tc && tc.settings && tc.settings.running) return tc.settings.running[key];
    return (this.settings.clockRunning || {})[key];
  }
  async setClockRunning(key, ts) {
    const tc = this.tabletopClocks();
    this.clockDone = this.clockDone || new Set();
    this.clockDone.delete(key);
    if (!key.startsWith("tile:") && tc && typeof tc.setRunning === "function") return tc.setRunning(key, ts);
    const r = { ...(this.settings.clockRunning || {}) };
    if (ts === null) delete r[key];
    else r[key] = ts;
    this.settings.clockRunning = r;
    this.saveSoon();
  }
  clockTimeUp(key, name) {
    this.clockDone = this.clockDone || new Set();
    if (this.clockDone.has(key)) return;
    this.clockDone.add(key);
    new Notice(`${name}: time's up.`);
    this.cards.showMessage({ title: name, text: "Time's up.", tone: "over" });
    if (this.settings.session.chime !== false) this.chime(1);
  }
  async pickClockNote(t) {
    const files = this.app.vault.getMarkdownFiles();
    const found = [];
    await Promise.all(files.map(async (f) => {
      try {
        const md = await this.app.vault.cachedRead(f);
        if (!/clocks/.test(md)) return;
        findClockBlocks(md).forEach((b, i) => found.push({ file: f, index: i, first: (b.body.split("\n").find((l) => l.trim()) || "").trim() }));
      } catch (e) { /* skip */ }
    }));
    if (!found.length) return new Notice("No note has a ```clocks block yet. Tabletop Clocks: \"Insert clocks\" adds one.");
    found.sort((a, b) => a.file.path.localeCompare(b.file.path) || a.index - b.index);
    new ListPicker(this.app, found, (x) => `${x.file.path.replace(/\.md$/, "")}${x.index ? ` (block ${x.index + 1})` : ""} — ${x.first}`, (x) => {
      this.updateTile(t, { path: x.file.path, clockBlock: x.index }, true);
    }, "Pick a note with clocks").open();
  }

  /** A sheet spell roll without a type: read healing / the damage type from the spell note. */
  spellRollKind(ctx) {
    if (!ctx || ctx.damageType || (ctx.kind !== "Damage" && ctx.kind !== "Healing")) return ctx;
    const target = String(ctx.link || ctx.action || "").replace(/\.md$/, "").trim();
    if (!target) return ctx;
    const f = this.app.metadataCache.getFirstLinkpathDest(target, ctx.whoPath || "");
    if (!(f instanceof TFile)) return ctx;
    const fm = (this.app.metadataCache.getFileCache(f) || {}).frontmatter || {};
    const sp = spellEffectKind(fm["Damage / Effect"] ?? fm["Damage/Effect"] ?? fm.damage_effect);
    if (sp) Object.assign(ctx, sp);
    return ctx;
  }

  /* ----- Randomness ----- */
  randomness() {
    const r = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins.randomness;
    return r && r.api && typeof r.api.rollUnscoped === "function" ? r.api : null;
  }
  starterFolder() {
    const r = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins.randomness;
    const root = String((r && r.settings && r.settings.generatorRoot) || "").replace(/^\/+|\/+$/g, "");
    return normalizePath(root ? `${root}/${STARTER_FOLDER}` : STARTER_FOLDER);
  }
  starterPath(file) { return file ? normalizePath(`${this.starterFolder()}/${file}`) : null; }
  starterInstalled() { return Object.keys(STARTER_FILES).every((f) => this.app.vault.getAbstractFileByPath(this.starterPath(f)) instanceof TFile); }
  async installStarterTables() {
    const folder = this.starterFolder();
    try {
      if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
      let made = 0;
      for (const [name, text] of Object.entries(STARTER_FILES)) {
        const path = this.starterPath(name);
        if (this.app.vault.getAbstractFileByPath(path)) continue; // never overwrite the GM's edits
        await this.app.vault.create(path, text);
        made++;
      }
      new Notice(made ? `Starter tables saved in ${folder}. Edit them like any Randomness file.` : `Starter tables are already in ${folder}.`);
      return true;
    } catch (e) {
      console.error(e);
      new Notice(`Couldn't save the starter tables: ${e.message || e}`);
      return false;
    }
  }
  /** Roll one table entry → { result, filePath } (null + notice on failure). */
  /** The note a table lives in (tables inside notes are rolled in that note's scope). */
  tableNote(entry) {
    if (entry.notePath) return entry.notePath;
    if (entry.filePath && /\.md$/i.test(entry.filePath)) return entry.filePath;
    const m = /^__note:([^^]+)\^/.exec(entry.name || "");
    if (m) {
      const f = this.app.metadataCache.getFirstLinkpathDest(m[1], "") || this.app.vault.getMarkdownFiles().find((x) => x.basename.toLowerCase() === m[1].toLowerCase());
      return f ? f.path : null;
    }
    return null;
  }
  /** Older entries saved Randomness' internal names ("__note:dungeony a pasti^roomContents"). */
  fixTableEntry(e) {
    if (!e || !/^__note:/.test(e.name || "")) {
      if (e && (e.group === "(this note)" || e.group === "(generator)")) {
        const np = this.tableNote(e);
        if (np) e.group = np.split("/").pop().replace(/\.md$/, "");
      }
      return e;
    }
    const np = this.tableNote(e);
    e.name = e.name.replace(/^__note:[^^]*\^/, "");
    if (np) { e.notePath = np; e.group = np.split("/").pop().replace(/\.md$/, ""); }
    if (!e.label || /^__note:|^ /.test(e.label) || /__note/.test(e.label)) e.label = humanizeTable(e.name);
    delete e.filePath;
    return e;
  }
  /** Roll one table entry → { result, filePath, notePath, prompt } (null + notice on failure). */
  async rollTable(entry, promptValues) {
    const api = this.randomness();
    if (!api) { new Notice("The Randomness plugin isn't on."); return null; }
    this.fixTableEntry(entry);
    const label = entry.label || entry.name;
    let notePath = this.tableNote(entry);
    if (!notePath && !entry.filePath && !entry.starter) {
      // saved without its note (e.g. picked as "(this note)"): find the note that defines it
      const hits = (await this.allRandomTables()).filter((x) => x.notePath && x.name.toLowerCase() === String(entry.name).toLowerCase());
      if (hits.length === 1) {
        notePath = entry.notePath = hits[0].notePath;
        entry.group = hits[0].group;
        if (hits[0].prompts && hits[0].prompts.length) entry.prompts = hits[0].prompts;
        if (!entry.label || entry.label === entry.name) entry.label = hits[0].label;
        this.saveSoon();
        this.refreshViews();
      }
    }
    const vals = (entry.prompts || []).map((p) => (promptValues && promptValues[p.label]) || p.def || p.options[0] || "");
    try {
      let result;
      let source;
      if (notePath) {
        // a table inside a note: roll it in that note's scope
        const pre = promptPrefix(vals);
        const r = await api.rollExpression(`${pre.expr}[@${entry.name}]`, { callerNotePath: notePath });
        if (!r || r.error) throw new Error((r && r.error) || "no result");
        result = String(r.result);
        if (pre.echo && result.startsWith(pre.echo)) result = result.slice(pre.echo.length);
        source = notePath;
      } else {
        const filePath = entry.filePath || (entry.starter ? this.starterPath(entry.starter) : undefined);
        const opts = filePath && this.app.vault.getAbstractFileByPath(filePath) ? { filePath } : {};
        if (vals.length) opts.promptValues = Object.fromEntries((entry.prompts || []).map((p, k) => [p.label, vals[k]]));
        const r = await api.rollUnscoped(entry.name, opts);
        if (!r || r.error) throw new Error((r && r.error) || "no result");
        result = String(r.result);
        source = r.source || filePath;
      }
      if (!String(result).trim()) throw new Error("the table gave an empty result");
      result = await this.expandTableLinks(result, notePath || "", 0);
      return { result, filePath: source, notePath, prompt: vals.join(", ") };
    } catch (e) {
      new Notice(`Couldn't roll ${label}: ${e.message || e}`);
      return null;
    }
  }
  /**
   * Atlas-style links in results ("[[#Gems (50 gp)|a 50 gp gem]]", "[[SRD tabulky#Trinkets|a trinket]]")
   * point at the heading of another table: roll that table and put its result in place of the link.
   */
  async expandTableLinks(text, notePath, depth) {
    const api = this.randomness();
    if (!api || depth > 4 || !/\[\[[^\]]*#/.test(text)) return text;
    const re = /\[\[([^\]|#]*)#([^\]|]+)(?:\|([^\]]+))?\]\]/g;
    let out = "";
    let last = 0;
    for (const m of text.matchAll(re)) {
      out += text.slice(last, m.index);
      last = m.index + m[0].length;
      let replacement = m[0];
      try {
        const target = m[1].trim();
        const file = target ? this.app.metadataCache.getFirstLinkpathDest(target, notePath) : this.app.vault.getAbstractFileByPath(notePath);
        if (file instanceof TFile && file.extension === "md") {
          const id = tableIdUnderHeading(await this.app.vault.cachedRead(file), m[2]);
          if (id) {
            const r = await api.rollExpression(`[@${id}]`, { callerNotePath: file.path });
            if (r && !r.error && String(r.result).trim()) replacement = await this.expandTableLinks(String(r.result), file.path, depth + 1);
          }
        }
      } catch (e) { /* keep the link */ }
      out += replacement;
    }
    return out + text.slice(last);
  }
  /** Every Randomness table: tables inside notes (by heading) and generator (.rdm) files. */
  async allRandomTables() {
    const api = this.randomness();
    const out = [];
    for (const f of this.app.vault.getMarkdownFiles()) {
      const c = this.app.metadataCache.getFileCache(f) || {};
      const hasIds = c.blocks && Object.keys(c.blocks).length;
      const hasCode = (c.sections || []).some((x) => x.type === "code");
      if (!hasIds && !hasCode) continue;
      let md = "";
      try { md = await this.app.vault.cachedRead(f); } catch (e) { continue; }
      if (!/\^[A-Za-z]|```\s*randomness|~~~\s*randomness/.test(md)) continue;
      for (const t of noteTablesIn(md)) out.push({ ...t, notePath: f.path, group: f.basename });
    }
    let gen = [];
    try { gen = api ? await api.tablesWithSources("") : []; } catch (e) { gen = []; }
    for (const x of gen) {
      if (!x || !x.name || /^__note:/.test(x.name) || x.inScope || !/\.(rdm|ipt)$/i.test(x.filePath || "")) continue;
      out.push({ name: x.name, label: humanizeTable(x.name), group: x.source || "Generators", filePath: x.filePath, prompts: [] });
    }
    return out;
  }
  async pickRandomTable(t) {
    if (!this.randomness()) return new Notice("The Randomness plugin isn't on.");
    const list = await this.allRandomTables();
    if (!list.length) return new Notice("No Randomness tables found. Install the starter tables, or give a table in a note a ^block id.");
    // "All tables in <note>": headings + codeblock tables nothing else in the note calls
    const byNote = new Map();
    for (const x of list) if (x.notePath) (byNote.get(x.notePath) || byNote.set(x.notePath, []).get(x.notePath)).push(x);
    const wholes = [...byNote.entries()].map(([notePath, xs]) => {
      const called = new Set(xs.filter((x) => x.kind === "block").flatMap((x) => (x.calls || [])).map((n) => n.toLowerCase()));
      const top = xs.filter((x) => x.kind !== "block" || !called.has(x.name.toLowerCase()));
      return { whole: true, notePath, group: xs[0].group, tables: top, label: `All ${top.length} tables`, name: "" };
    }).filter((w) => w.tables.length > 1);
    const mk = (x) => {
      const e = { id: uid(), group: x.group, label: x.label, name: x.name };
      if (x.notePath) e.notePath = x.notePath;
      if (x.filePath) e.filePath = x.filePath;
      if (x.prompts && x.prompts.length) e.prompts = x.prompts;
      return e;
    };
    new ListPicker(this.app, [...wholes, ...list], (x) => (x.whole
      ? `📄 ${x.group} — ${x.label} from this note`
      : `${x.label}${x.prompts && x.prompts.length ? ` (asks ${x.prompts.map((p) => p.label).join(", ")})` : ""} — ${x.group}${x.label !== x.name ? `  ·  ${x.name}` : ""}`), (x) => {
      t.tables = t.tables || [];
      if (x.whole) {
        const have = new Set(t.tables.filter((e) => e.notePath === x.notePath).map((e) => e.name.toLowerCase()));
        t.tables.push(...x.tables.filter((e) => !have.has(e.name.toLowerCase())).map(mk));
      } else t.tables.push(mk(x));
      this.updateTile(t, {}, true);
    }, "Pick a random table, or a whole note of tables").open();
  }

  /* ----- loot handout (One DnD Character Sheet inventory) ----- */
  /** Starter loot tables are loot; other tables only when the GM says so (or by default when they look like it). */
  isLootEntry(e) {
    if (!e) return null;
    if (typeof e.loot === "boolean") return e.loot;
    if (e.starter) return e.starter === "GM Screen Loot.rdm";
    return null;
  }
  isLootResult(h, t) {
    const e = (t && t.tables || []).find((x) => x.id === h.tableId);
    const flag = e ? this.isLootEntry(e) : typeof h.loot === "boolean" ? h.loot : null;
    if (flag !== null) return flag && parseLoot(h.result).any;
    const L = parseLoot(h.result);
    return COINS.some((k) => L.coins[k]) || L.items.some((x) => x.cost);
  }
  /** A character note → hand-out target (its sheet Inventory companion). */
  lootMember(f) {
    const fm = this.party.fm(f);
    const name = fm[this.settings.nameKey] || fm.character_name || f.basename;
    return { kind: "character", label: name, name, file: f, path: this.party.companionPath(f, fm, "Inventory") };
  }
  /** Parties to hand loot to: the sheet's party groups (with their shared inventory), or the GM screen's party. */
  lootParties() {
    const out = [];
    for (const g of this.party.sheetGroups()) {
      if (!g || !g.name) continue;
      const seen = new Set();
      const members = (g.members || []).map((m) => this.party.resolveNote(m)).filter((f) => f && !seen.has(f.path) && seen.add(f.path)).map((f) => this.lootMember(f));
      out.push({ name: g.name, members, inventory: { kind: "party", label: `Party inventory (${g.name})`, name: g.name, path: normalizePath(`${this.party.dataFolder}/_Party/${slugParty(g.name)}/Inventory.md`) } });
    }
    if (!out.length) {
      const members = this.party.members(null).map((f) => this.lootMember(f));
      if (members.length) out.push({ name: "Party", members, inventory: null });
    }
    return out;
  }
  /** The party picked in the GM screen settings, when it's a sheet party group. */
  defaultLootParty(parties) {
    const pt = this.settings.party || {};
    const i = pt.mode === "sheetGroup" ? parties.findIndex((x) => x.name === String(pt.value || "").trim()) : -1;
    return i >= 0 ? i : 0;
  }
  /** An item note (#Item) with this name, for item_link / cost / weight. */
  itemNote(name) {
    const n = String(name || "").trim().toLowerCase();
    if (!n) return null;
    this.itemIndex = this.itemIndex && Date.now() - this.itemIndex.at < 30000 ? this.itemIndex : { at: Date.now(), map: null };
    if (!this.itemIndex.map) {
      const map = new Map();
      for (const f of this.app.vault.getMarkdownFiles()) {
        const c = this.app.metadataCache.getFileCache(f);
        if (!c) continue;
        const tags = (getAllTags(c) || []).map((x) => x.toLowerCase());
        if (!tags.some((x) => x === "#item" || x.startsWith("#item/"))) continue;
        map.set(itemKey(f.basename), f);
      }
      this.itemIndex.map = map;
    }
    return this.itemIndex.map.get(itemKey(n)) || null;
  }
  async ensureInventory(target) {
    let f = this.app.vault.getAbstractFileByPath(target.path);
    if (f instanceof TFile) return f;
    const folder = target.path.split("/").slice(0, -1).join("/");
    if (folder && !this.app.vault.getAbstractFileByPath(folder)) {
      try { await this.app.vault.createFolder(folder); } catch (e) { /* made meanwhile */ }
    }
    const head = target.kind === "party" ? `party_name: ${JSON.stringify(target.name)}\n` : "";
    try {
      f = await this.app.vault.create(target.path, `---\ncssclasses:\n  - dnd-sheet\n${head}inventory_list: []\ncurrency:\n  pp: 0\n  gp: 0\n  ep: 0\n  sp: 0\n  cp: 0\n---\n`);
    } catch (e) {
      f = this.app.vault.getAbstractFileByPath(target.path);
    }
    if (!(f instanceof TFile)) throw new Error(`no inventory file at ${target.path}`);
    return f;
  }
  async giveTo(target, items, coins) {
    const f = await this.ensureInventory(target);
    await this.app.fileManager.processFrontMatter(f, (fm) => {
      if (!Array.isArray(fm.inventory_list)) fm.inventory_list = [];
      for (const it of items || []) {
        const note = (it.link && this.itemNote(String(it.link).split("/").pop())) || this.itemNote(it.name);
        const nfm = note ? this.party.fm(note) : {};
        const linkText = note ? this.app.metadataCache.fileToLinktext(note, f.path) : "";
        fm.inventory_list.push({
          id: invId(),
          name: it.name,
          weight: nfm.weight_lb !== undefined && nfm.weight_lb !== null ? nfm.weight_lb : "",
          qty: it.qty || 1,
          cost: it.cost || (nfm.cost !== undefined && nfm.cost !== null ? String(nfm.cost) : ""),
          equipped: false,
          item_link: note ? `[[${linkText}]]` : "",
        });
      }
      if (coins && COINS.some((k) => coins[k])) {
        const cur = fm.currency && typeof fm.currency === "object" ? fm.currency : {};
        const next = {};
        for (const k of COINS) next[k] = (Number(cur[k]) || 0) + (coins[k] || 0);
        fm.currency = next;
      }
    });
  }
  /** Carry out a hand-out plan [{ target, items, coins }]. Returns a short "who got it" line. */
  async handOutLoot(plan) {
    const said = [];
    for (const p of plan) {
      await this.giveTo(p.target, p.items, p.coins);
      const bits = [];
      if (p.items.length) bits.push(p.items.map((x) => (x.qty > 1 ? `${x.qty}× ${x.name}` : x.name)).join(", "));
      if (COINS.some((k) => p.coins[k])) bits.push(coinText(p.coins));
      said.push(`${p.target.kind === "party" ? `Party (${p.target.name})` : p.target.name}: ${bits.join(" + ")}`);
    }
    new Notice(`Handed out – ${said.join(" · ")}`);
    return plan.map((p) => (p.target.kind === "party" ? "Party" : p.target.name)).join(", ");
  }

  /** A ready sound button for a dropped audio file or folder (null if it holds no audio). */
  padFromFile(f) {
    if (isAudio(f)) return { id: uid(), label: f.basename, kind: "effect", src: { type: "file", path: f.path }, order: "order", volume: 80 };
    if (f instanceof TFolder) {
      const pad = { id: uid(), label: f.name, kind: "music", src: { type: "folder", path: f.path }, order: "shuffle", volume: 80 };
      return this.sound.tracks(pad).length ? pad : null;
    }
    return null;
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
    for (const k of ["type", "path", "heading", "level", "mapIndex", "mapId", "mapLine", "blockId", "title", "text", "color", "items", "pads", "clocks", "clockBlock", "tables", "history", "image", "markers", "expanded", "partKind", "ref", "index"]) if (spec[k] !== undefined) tile[k] = spec[k];
    const box = tileBox(tile);
    Object.assign(tile, freeSpot(sc.tiles, box.w, box.h, width));
    sc.tiles.push(tile);
    await this.saveSettings();
    if (!view) await this.activate();
    this.views().forEach((v) => v.renderBoard());
    const label = this.views()[0] ? this.views()[0].tileTitle(tile) : tile.type;
    new Notice(`Added ${label} to "${sc.name}"`);
  }
  /** Add a note: ask whether it's the whole note or one part of it. */
  async addNoteWithPicker(file) {
    if (!(file instanceof TFile)) return;
    let parts = [];
    try { parts = noteParts(await this.app.vault.cachedRead(file)); } catch (e) { parts = []; }
    if (!parts.length) return this.addTile({ type: "note", path: file.path });
    new NotePartPicker(this, file, parts).open();
  }
  async addNotePart(file, x) {
    switch (x.kind) {
      case "heading": return this.addTile({ type: "section", path: file.path, heading: x.heading, level: x.level });
      case "block": return this.addTile({ type: "part", path: file.path, partKind: "block", ref: x.id });
      case "callout": return this.addTile({ type: "part", path: file.path, partKind: "callout", ref: x.title, index: x.index });
      case "statblock": return this.addTile({ type: "part", path: file.path, partKind: "statblock", ref: x.name, index: x.index });
      case "image": {
        const img = this.app.metadataCache.getFirstLinkpathDest(x.target, file.path) || this.app.vault.getAbstractFileByPath(x.target);
        if (!(img instanceof TFile)) return new Notice(`Couldn't find the picture ${x.target}.`);
        const mk = this.markersFor(img.path);
        return this.addTile({ type: "map", path: img.path, image: img.path, markers: mk ? mk.path : undefined, expanded: true });
      }
      case "map": {
        const blocks = findMapBlocks(await this.app.vault.cachedRead(file));
        const block = blocks[x.index];
        if (block) return this.addMapTile(file, { index: x.index, block });
        return null;
      }
      default: return this.addTile({ type: "note", path: file.path });
    }
  }
  zoomMap() {
    return this.app.plugins && this.app.plugins.plugins ? this.app.plugins.plugins["zoom-map"] || null : null;
  }
  /** The markers.json of a map image (the one saved on the tile first, then TTRPG Tools - Maps' names). */
  markersFor(imagePath, preferred) {
    for (const p of [preferred, ...markersCandidates(imagePath)]) {
      if (!p) continue;
      const f = this.app.vault.getAbstractFileByPath(p);
      if (f instanceof TFile) return f;
    }
    return null;
  }
  /** Add → Map…: every image in the vault, TTRPG Tools maps (an image with a markers.json) marked. */
  async pickMapImage() {
    const files = this.app.vault.getFiles();
    const items = files.filter(isImage).map((f) => ({ image: f, markers: this.markersFor(f.path) }));
    const covered = new Set(items.filter((x) => x.markers).map((x) => x.markers.path));
    // markers.json files whose image has another name (e.g. a map with several layers)
    for (const j of files.filter((f) => /\.markers\.json$/i.test(f.path) && !covered.has(f.path))) {
      try {
        const ip = imageFromMarkers(await this.app.vault.cachedRead(j));
        const img = ip && this.app.vault.getAbstractFileByPath(ip);
        if (img instanceof TFile && isImage(img)) items.push({ image: img, markers: j, viaJson: true });
      } catch (e) { /* not a map file */ }
    }
    // an image that is a TTRPG map through a differently-named markers.json isn't also listed as a plain picture
    const mapped = new Set(items.filter((x) => x.markers).map((x) => x.image.path));
    for (let i = items.length - 1; i >= 0; i--) if (!items[i].markers && mapped.has(items[i].image.path)) items.splice(i, 1);
    if (!items.length) return new Notice("No images in the vault yet.");
    items.sort((a, b) => (b.markers ? 1 : 0) - (a.markers ? 1 : 0) || a.image.path.localeCompare(b.image.path));
    new ListPicker(this.app, items, (x) => `${x.markers ? "🗺 " : "🖼 "}${x.image.path}${x.markers ? `  ·  TTRPG map${x.viaJson ? ` (${x.markers.name})` : ""}` : ""}`, (x) => {
      if (x.markers && !this.zoomMap()) new Notice("TTRPG Tools - Maps isn't on, so the map is shown as a plain picture (no markers).");
      this.addTile({ type: "map", path: x.image.path, image: x.image.path, markers: x.markers ? x.markers.path : undefined, expanded: true });
    }, "Pick a map image (🗺 = TTRPG Tools map with markers)").open();
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

    /* Session timer */
    new Setting(el).setName("Session timer").setHeading();
    new Setting(el)
      .setName("Session length")
      .setDesc("How long you plan to play, e.g. 4 h, 3:30 or 210 min.")
      .addText((t) => t.setValue(durationText(s.session.minutes)).onChange(async (v) => {
        const m = parseDuration(v);
        if (m) { s.session.minutes = m; await this.save(false); }
      }));
    new Setting(el)
      .setName("Reminder")
      .setDesc("Minutes before the end when you get a reminder (0 = only when time is up).")
      .addText((t) => t.setValue(String(s.session.warn)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0) { s.session.warn = n; await this.save(false); }
      }));
    new Setting(el)
      .setName("Chime")
      .setDesc("Play a short chime with the reminder and when a timer runs out.")
      .addToggle((t) => t.setValue(s.session.chime !== false).onChange(async (v) => { s.session.chime = v; await this.save(false); }));

    /* Soundboard */
    new Setting(el).setName("Soundboard").setHeading();
    new Setting(el)
      .setName("Fade")
      .setDesc("How long music and ambience take to fade in and out (seconds). 0 = cut straight away.")
      .addSlider((sl) => sl.setLimits(0, 5, 0.5).setValue((s.sound.fade || 0) / 1000).setDynamicTooltip().onChange(async (v) => { s.sound.fade = Math.round(v * 1000); await this.save(false); }));

    /* Combat */
    new Setting(el).setName("Combat").setHeading();
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
  PartyReader, ResponsiveNotes, rollContext, rollWhat, snapResize, screenToJson, screenFromJson, SoundBoard, SoundPadModal, padKind, padLoops, isAudio, noteParts, notePartMarkdown, NotePartPicker, combineFights, markersCandidates, imageFromMarkers, imageMapMarkdown, spellEffectKind, noteTablesIn, tableIdUnderHeading, humanizeTable, promptPrefix, parseLoot, splitCoins, plainResult, slugParty, STARTER_TABLES, STARTER_FILES, LootHandoutModal, parseClocks, ckRemovePart, ckSetFill, ckSetValue, ckAdd, findClockBlocks, replaceClockBlock, parseDuration, hms, hm, insertNotes, spellcasting, findInitiativeBlock, combatBlock, extractSection, findMapBlocks, mapMarkdown, pickMap, cleanHeading, fillTokens, lastSessionNumber, padNum, cleanFileName, freeSpot, tileBox, isOpenTile, snapToTiles,
};
