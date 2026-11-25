## 1.1.0

### Added
- **Table tile** ("Table (editable)" in the add-tile menu): editable tables you fill in during play, separate from the random tables.
  - Columns can be text, numbers (with − and + buttons) or checkboxes.
  - Add, remove, reorder and retype columns from the arrow in each column header; add and remove rows.
  - Optional totals row: sums number columns and counts ticked checkboxes.
  - Text cells wrap onto several lines and the row grows to fit. Shift+Enter adds a line break; Enter moves down and adds a row at the end.
  - Drag the edge of a column header to resize that column. The tile is always exactly as wide as its table, so stretching a column stretches the tile (the tile's corner grip changes the height only).
  - Header names wrap too, and a column can't be dragged narrower than its longest header word.
  - Tile menu: Add row / column, Show or hide totals, Edit as markdown…, Copy as markdown, Untick all and reset numbers to 0, Reset column widths, Clear all rows.
  - "Edit as markdown…" and "Copy as markdown" convert to and from normal markdown tables (☐ / ☑ become checkbox columns, plain numbers become number columns), so you can paste a table from a note or copy one back into a note.

### Changed
- The scrollable board now extends only 20 px beyond the outermost tile (it was 200 px), so scrollbars no longer appear when every tile already fits on screen.
