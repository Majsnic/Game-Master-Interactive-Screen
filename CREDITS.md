# Credits

Game Master Interactive Screen is a separate plugin with its own code. It works together with these plugins through what they already offer (their public APIs, events, code blocks and file formats). None of their code is bundled. Thank you to their authors.

| Plugin | Author | What the GM screen uses |
|---|---|---|
| [Dice Roller](https://github.com/javalent/dice-roller) | Jeremy Valentine (javalent) | Its 3D dice, thrown inside the GM screen's dice tray; rolls clicked on character sheets and statblocks are shown as result cards |
| [Fantasy Statblocks](https://github.com/javalent/fantasy-statblocks) | Jeremy Valentine (javalent) | Statblocks render inside pinned notes and popups; who rolled what is read from them |
| TTRPG Tools – Maps | Jareika | ` ```zoommap ``` ` maps pinned as tiles |
| TTRPG Tools – Time | Jareika | The in-game date and time and its time buttons, shown on the Clocks & timers tile |
| TTRPG Tools – Player Screen | Jareika | Used by Roll for Initiative to show the fight to players |
| Tabletop Clocks | Bananafest Destiny | The ` ```clocks ``` ` text format (progress clocks, races, counters, stopwatches). The Clocks & timers tile reads and writes the same format and fires the same events, so clocks move freely between notes and the screen |
| Randomness | Josh | Random tables are rolled through its public API; the starter tables are ordinary Randomness generator files |
| Roll for Initiative | Majsnic | Combat bar, fights pinned to the screen, initiative and HP rolls in the dice tray, "Who takes the damage?" |
| One DnD Character Sheet | Majsnic | Live party cards (HP, AC, passives, spell DC, conditions, spell slots) and the loot hand-out into character and party inventories |

## Starter random tables

The optional starter tables (`GM Screen Loot.rdm`, `GM Screen Everyday.rdm`) are original content written for this plugin. Coin amounts and magic-item counts follow the treasure-by-challenge-rating guidelines of the 2024 rules; item names are the common names of magic items and gems. No rules text is included.
