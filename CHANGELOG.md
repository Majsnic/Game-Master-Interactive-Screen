# Changelog

All notable changes to Game Master Interactive Screen. Newest first.

## 1.0.0 – 2026-11-12
### Added
- **Several initiatives at once** (Roll for Initiative 1.8+). When fights are linked to run together, the combat bar treats them as one fight:
  - **Next** is who really acts next across all of them, in the shared initiative order Roll for Initiative uses, with the fight's name when it's in the other one (e.g. *Next: Goblin · Cave*).
  - **Turn** always shows the fight that has the turn, whichever fight changed last.
  - A **"2 initiatives"** badge lists the fights; click one to open it.
  - Party cards mark only the character whose turn it really is, and who's really on deck.
### Fixed
- A tile on top now fully covers the tiles under it. Before, parts of a note underneath (anything with its own layering in the note's CSS) could show through a map or another tile placed over it.
### Notes
- One fight, or an older Roll for Initiative: everything works as before.

## 0.15.0 – 2026-11-12
### Added
- **Add just part of a note**, like Obsidian embeds. When you add a note (search **+**, **Add → Note…**, right-click a note → **Add to Game Master screen…**, or the *Add active note* command), a picker lets you choose:
  - 📄 the whole note,
  - **# a heading** and everything under it,
  - **¶ a block** marked with `^id` (a paragraph, list item or whole table; a table shows its header row in the list),
  - **💬 a callout** (nested callouts listed indented),
  - **🐉 a statblock** (Fantasy Statblocks), by monster name,
  - **🖼 a picture** embedded in the note (opens in the zoom / pan viewer, or as a TTRPG map if it has markers),
  - **🗺 a map** (` ```zoommap ``` ` block).
- New **Add → Note…** entry in the toolbar menu.
- A note with nothing to pick from is added whole, without the picker.
### Notes
- Part tiles follow the note: edit the note and the tile updates. If the block, callout or statblock is removed, the tile says so instead of breaking.

## 0.14.0 – 2026-11-12
### Added
- **Add → Map…** puts a map on the screen straight from an image in your vault.
  - An image that has a **TTRPG Tools – Maps** markers file next to it (`map.png.markers.json` or `map.markers.json`, or any `.markers.json` that names the image) opens as the full interactive map, with its markers, layers and tools. It's marked 🗺 in the picker.
  - Any other image (🖼) opens as a **picture you can zoom and pan**: mouse wheel to zoom, drag to move, double-click to fit it back.
- Right-click an image in the file explorer → **Add map to Game Master screen**.
### Notes
- Maps added this way never use the image file as their "source note", so TTRPG Tools – Maps can't write into the image. Its *save view to YAML* actions just say "Source note not found"; markers still save to the markers file.

## 0.13.0 – 2026-11-12
### Added
- **Random tables inside notes.** Markdown tables with a `^tableId` and `Table:` blocks in ` ```randomness ``` ` codeblocks can now be pinned and rolled. That's the same format Atlas VTT reads, so one set of tables works in both.
  - The picker lists them by their heading (e.g. *Individual Treasure (CR 0–4)*) under the note's name, next to the `.rdm` generator tables.
  - **All tables from a note** at once: helper tables that another table calls are left out.
- **Prompts.** A table with a `Prompt:` (e.g. CR or level band) asks for the value when you click it and remembers your last choice. *Roll again* uses the same value.
- **Heading links are rolled**, like Atlas does. A result such as `[[#Gems (50 gp)|a 50 gp gem]]` or `[[SRD tabulky#Trinkets|a trinket]]` gets the linked table's roll in its place.
- Results show as Markdown, so item links are clickable.
### Fixed
- Pinned tables from notes no longer fail with "Couldn't roll". Buttons saved earlier with Randomness' internal names (`__note:…^…`) or as "(this note)" are repaired automatically.
- **Hand out…** reads Atlas-style loot: "8 × 10 gp", "5,000 gp", "110 pp and Carnelian (50 gp)", and items given as `[[links]]`. Linked items are matched to their item notes.

## 0.12.4 – 2026-11-10
### Changed
- The fallback folder for character-sheet data is now `Compendium/Character Sheet Data`, matching the public One DnD Character Sheet. It is only used when the sheet doesn't report its own folder.
- Updated the plugin description.

## 0.12.3 – 2026-11-10
### Fixed
- Works with One DnD Character Sheet 1.8. The Actions tab no longer has a Type column, so the GM screen stopped reading the range cell ("20/60 ft.") as a damage type. Only real damage types (fire, piercing, …) are accepted now.

## 0.12.2 – 2026-11-09
### Fixed
- Healing spells rolled from the character sheet (Cure Wounds, Healing Word…) are now recognised as **healing**, not damage. The GM screen reads the spell note's *Damage / Effect*. The result card says *Healing* and offers *Heal someone…*, and Roll for Initiative asks *Who takes the heal?*.
- Damage spells get their damage type from the spell note too (Fire Bolt → *Damage: Fire*).

## 0.12.1 – 2026-11-09
### Changed
- **Hand out loot** reworked:
  - pick the **party** first; only that party's members are offered;
  - choose **who takes each item** (a member, the party's shared inventory, or nobody), or give everything to one person;
  - coins can be **split evenly** between the members you tick (with a preview) or go to one member or the party inventory.

## 0.12.0 – 2026-11-09
### Added
- **Random tables** tile (needs the Randomness plugin):
  - pin any Randomness table as a button and click to roll;
  - results stay in a list with *Roll again*, *Copy* and *Hand out…*.
- **Starter tables**, installed on request into your Randomness folder and editable like any generator file:
  - pocket loot and treasure hoards by challenge rating, magic items by rarity, gems, art objects, trinkets, pocket junk;
  - tavern names, NPC quirks, rumours, complications, weather.
- **Hand out loot** to One DnD Character Sheet inventories and party inventories. Items are linked to matching item notes; coins are added to the character's purse.

## 0.11.2 – 2026-11-09
### Fixed
- A clock with a filled segment stopped drawing after its outer ring (no name, buttons or ×), so it couldn't be removed.

## 0.11.1 – 2026-11-09
### Added
- **×** button on every clock, counter, timer and heading. In an "A vs B" race it removes only that side.
- **ⓘ** cheat sheet in the Clocks tile's title bar. Click an example to put it in the add box.

## 0.11.0 – 2026-11-09
### Added
- **Clocks & timers** tile:
  - **Session timer**: set the session length, then start, pause and add 15 minutes. You get a **reminder 30 minutes before the end** (configurable: notice, card and chime) and another when time is up. A toolbar chip shows the time left on every screen.
  - **In-game time** from TTRPG Tools – Time, with its own time buttons.
  - **Clocks** in the Tabletop Clocks text format: progress clocks, races, counters, stopwatches and countdowns. They are kept on the screen or linked to a ` ```clocks ``` ` block in a note.
- Commands: *Session timer: start / pause*.

## 0.10.0 – 2026-11-09
### Added
- **Soundboard** tile:
  - Stream Deck-style buttons for a track, a folder (in order or shuffled) or a web link;
  - three button types: Music (one at a time, with crossfade), Ambience (loops alongside other sounds) and Sound effect;
  - master volume, *Stop all*, drag-and-drop from the file explorer;
  - command *Soundboard: stop all sounds*.
### Removed
- Concentration at a glance. It now lives in Roll for Initiative.

## 0.9.1 – 2026-11-05
### Fixed
- The resize corner was hidden under note content and checklists, so only some tiles could be resized.

## 0.9.0 – 2026-11-05
### Added
- **Lock layout** per screen (toolbar button and tab menu).
- Tiles **snap to neighbours while resizing**.
- **Screen templates**, **export** and **import** (JSON, copied or saved as `.gmscreen.json`).
- **Checklist** tile with a clipboard-on-a-wood-board look.
- Concentration at a glance (removed again in 0.10.0).

## 0.8.1
### Fixed
- Sticky notes: text sits on the ruled lines with any font, and long lines wrap instead of disappearing.

## 0.8.0
### Added
- **Sticky notes**: paper look in five colours, handwriting font, text that scales with the note, kept only on the screen.

## 0.7.3
### Added
- **Apply damage… / Heal someone…** on damage and healing result cards (through Roll for Initiative).
- Event `game-master-screen:rolled` after every roll, for other plugins.

## 0.7.2
### Added
- Result cards say **who rolled what**: the character or creature, the total, the dice, and the action with its damage type (read from character sheets and statblocks).
- The character sheet's *Jump to…* menu works inside popups.

## 0.7.1
### Added
- Narrow popups switch notes to their **phone layout**.

## 0.7.0
### Added
- **Roll for Initiative** integration:
  - *Add → Combat* opens its wizard and pins the fight;
  - **combat bar** with round, turn and next, plus buttons;
  - party cards show initiative and whose turn it is;
  - initiative and HP rolls are thrown in the dice tray;
  - add a monster to the fight from search.

## 0.6.0
### Added
- **Dice Roller's 3D dice** are thrown inside the dice tray.

## 0.5.1
### Added
- **Dice tray** with 3D dice, advantage / disadvantage, critical hits and fumbles.
- Result cards for every roll, bottom right.
### Fixed
- Clicking a pinned note opens its popup only once.

## 0.4.1
### Added
- Combat builder: pick a whole party or single characters, and remove members.

## 0.4.0
### Added
- Combat builder tile (encounter name, party, enemies), pinned to the screen. Replaced by Roll for Initiative's wizard in 0.7.0.

## 0.3.1
### Added
- Tiles **snap** to each other when dragged close.

## 0.3.0
### Added
- Party cards: **AC shield**, *Passive* and *Spellcasting* groups (spell save DC, spell attack).
- Session notes became a writing pad: **Done** creates the session note from your template.
### Removed
- The *Note: Úvod* and *New session* menu items.

## 0.2.1
### Added
- Each party tile can have its own members, added through a character picker.
- Shrink a tile to its name and restore it to its previous size.
### Fixed
- Dragging popups no longer lags.
- Pinned notes render with the note's own look (CSS classes).
- Maps can be resized and fill their tile.

## 0.2.0
### Added
- **Tabs**: several screens.
- Pinned notes show only the name; click to open a **movable popup**.
- Pin a **section** (heading) or a **map** (TTRPG Tools – Maps).
- **Session diary** with a naming pattern, date and template.

## 0.1.0
### Added
- First version: a GM screen view with freely placed tiles, live **party cards**, a **search bar** for your notes, and pinned notes.
